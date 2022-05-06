import assert from "assert"
import cp from "child_process"
import { randomUUID } from "crypto"
import { parseISO } from "date-fns"
import EventEmitter from "events"
import { extractRequestError, MatrixClient } from "matrix-bot-sdk"
import { Probot } from "probot"

import { getSortedTasks } from "src/db"

import { prepareBranch } from "./core"
import { getPostPullRequestResult, updateComment } from "./github"
import {
  cancelGitlabPipeline,
  restoreTaskGitlabContext,
  runCommandInGitlabPipeline,
} from "./gitlab"
import { Logger } from "./logger"
import { CommandOutput, Context, GitRef } from "./types"
import { displayError, getNextUniqueIncrementalId, intoError } from "./utils"

/* 
  Only useful as a means to know which tasks are alive so that unfinished tasks
  are not queued twice on requeue attempts
*/
export const queuedTasks: Set<string> = new Set()

export type TaskGitlabPipeline = {
  id: number
  projectId: number
  webUrl: string
}
type TaskBase<T> = {
  tag: T
  id: string
  queuedDate: string
  timesRequeued: number
  timesRequeuedSnapshotBeforeExecution: number
  timesExecuted: number
  gitRef: GitRef
  repoPath: string
  requester: string
  gitlab: {
    job: {
      tags: string[]
      image: string
    }
    pipeline: TaskGitlabPipeline | null
  }
  command: string
}

export type PullRequestTask = TaskBase<"PullRequestTask"> & {
  commentId: number
  installationId: number
  gitRef: GitRef & { prNumber: number }
}

export type ApiTask = TaskBase<"ApiTask"> & {
  matrixRoom: string
}

export type Task = PullRequestTask | ApiTask

export const getNextTaskId = () => {
  return `${getNextUniqueIncrementalId()}-${randomUUID()}`
}

export const serializeTaskQueuedDate = (date: Date) => {
  return date.toISOString()
}

export const parseTaskQueuedDate = (str: string) => {
  return parseISO(str)
}

export const queueTask = async (
  parentCtx: Context,
  task: Task,
  {
    onResult,
    updateProgress,
  }: {
    onResult: (result: CommandOutput) => Promise<unknown>
    updateProgress?: (message: string) => Promise<unknown>
  },
) => {
  assert(
    !queuedTasks.has(task.id),
    `Attempted to queue task ${task.id} when it's already registered in the taskMap`,
  )
  queuedTasks.add(task.id)

  const ctx = {
    ...parentCtx,
    logger: parentCtx.logger.child({ taskId: task.id }),
  }
  const { logger, taskDb, getFetchEndpoint } = ctx
  const { db } = taskDb

  await db.put(task.id, JSON.stringify(task))

  const taskTerminationEventChannel = new EventEmitter()
  let terminateTask: (() => Promise<Error | undefined>) | undefined = undefined
  let activeProcess: cp.ChildProcess | undefined = undefined
  let taskIsAlive = true
  const terminate = async () => {
    if (terminateTask) {
      const terminationError = await terminateTask()
      if (terminationError) {
        logger.error(terminationError, "Unable to terminate task")
        return
      }
      terminateTask = undefined
      taskTerminationEventChannel.emit("finished")
    }

    taskIsAlive = false

    queuedTasks.delete(task.id)

    await db.del(task.id)

    logger.info(
      { task, queue: await getSortedTasks(ctx) },
      "Queue state after termination of task",
    )

    if (activeProcess === undefined) {
      return
    }

    activeProcess.kill()
    logger.info(`Killed child with PID ${activeProcess.pid ?? "?"}`)

    activeProcess = undefined
  }

  const cancelledMessage = "Command was cancelled"

  const afterTaskRun = (result: CommandOutput | null) => {
    const wasAlive = taskIsAlive

    void terminate().catch((error) => {
      logger.error(error, "Failed to terminate task on afterTaskRun")
    })

    if (wasAlive && result !== null) {
      void onResult(result)
    }
  }

  const runTask = async () => {
    try {
      await db.put(
        task.id,
        JSON.stringify({
          ...task,
          timesRequeuedSnapshotBeforeExecution: task.timesRequeued,
          timesExecuted: task.timesExecuted + 1,
        }),
      )

      const restoredTaskGitlabCtx = await restoreTaskGitlabContext(ctx, task)

      if (restoredTaskGitlabCtx === null) {
        return null
      }

      const taskStartResult =
        restoredTaskGitlabCtx ??
        (await (async () => {
          if (taskIsAlive) {
            logger.info(
              { task, currentTaskQueue: await getSortedTasks(ctx) },
              "Starting task",
            )
          } else {
            logger.info(task, "Task was cancelled before it could start")
            return cancelledMessage
          }

          const prepareBranchSteps = prepareBranch(ctx, task, {
            getFetchEndpoint: () => {
              return getFetchEndpoint(
                "installationId" in task ? task.installationId : null,
              )
            },
          })
          while (taskIsAlive) {
            const next = await prepareBranchSteps.next()
            if (next.done) {
              break
            }

            activeProcess = undefined

            if (typeof next.value !== "string") {
              return next.value
            }
          }
          if (!taskIsAlive) {
            return cancelledMessage
          }

          const pipelineCtx = await runCommandInGitlabPipeline(ctx, task)

          task.gitlab.pipeline = {
            id: pipelineCtx.id,
            webUrl: pipelineCtx.webUrl,
            projectId: pipelineCtx.projectId,
          }
          await db.put(task.id, JSON.stringify(task))

          if (updateProgress) {
            await updateProgress(
              `@${task.requester} ${pipelineCtx.webUrl} was started`,
            )
          }

          return pipelineCtx
        })())

      if (
        taskStartResult instanceof Error ||
        typeof taskStartResult === "string"
      ) {
        return taskStartResult
      }

      terminateTask = taskStartResult.terminate
      await taskStartResult.waitUntilFinished(taskTerminationEventChannel)

      return `${taskStartResult.webUrl} ${
        taskIsAlive ? "was cancelled" : "finished"
      }`
    } catch (error) {
      return intoError(error)
    }
  }
  void runTask().then(afterTaskRun).catch(afterTaskRun)

  return "Command was queued. This comment will be updated when execution starts."
}

export const requeueUnterminatedTasks = async (ctx: Context, bot: Probot) => {
  const { taskDb, logger, matrix } = ctx
  const { db } = taskDb

  /*
    unterminatedItems are leftover tasks from previous server instances which
    were not finished properly for some reason (e.g. the server was restarted).
  */
  const unterminatedItems = await getSortedTasks(ctx, { onlyNotAlive: true })

  for (const {
    task: { timesRequeued, ...task },
    id,
  } of unterminatedItems) {
    await db.del(id)

    const prepareRequeuedTask = <T>(prevTask: T) => {
      logger.info(prevTask, "Prepare requeue")
      return { ...prevTask, timesRequeued: timesRequeued + 1 }
    }

    type RequeueComponent = {
      requeue: () => Promise<unknown> | unknown
      announceCancel: (msg: string) => Promise<unknown> | unknown
    }
    const getRequeueResult = async (): Promise<RequeueComponent | Error> => {
      try {
        switch (task.tag) {
          case "PullRequestTask": {
            const {
              gitRef: { owner, repo, prNumber: prNumber },
              commentId,
              requester,
            } = task

            const octokit = await bot.auth(task.installationId)

            const announceCancel = (message: string) => {
              return updateComment(ctx, octokit, {
                owner,
                repo,
                pull_number: prNumber,
                comment_id: commentId,
                body: `@${requester} ${message}`,
              })
            }

            const requeuedTask = prepareRequeuedTask(task)
            const requeue = () => {
              return queueTask(ctx, requeuedTask, {
                onResult: getPostPullRequestResult(ctx, octokit, requeuedTask),
              })
            }

            return { requeue, announceCancel }
          }
          case "ApiTask": {
            if (matrix === null) {
              return {
                announceCancel: () => {
                  logger.warn(
                    task,
                    "ApiTask cannot be requeued because Matrix client is missing",
                  )
                },
                requeue: () => {},
              }
            }

            const { matrixRoom } = task
            const sendMatrixMessage = (msg: string) => {
              return matrix.sendText(matrixRoom, msg)
            }

            const requeuedTask = prepareRequeuedTask(task)
            return {
              announceCancel: sendMatrixMessage,
              requeue: () => {
                return queueTask(ctx, requeuedTask, {
                  onResult: getSendTaskMatrixResult(
                    matrix,
                    logger,
                    requeuedTask,
                  ),
                })
              },
            }
          }
          default: {
            const exhaustivenessCheck: never = task
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            throw new Error(`Not exhaustive: ${exhaustivenessCheck}`)
          }
        }
      } catch (error) {
        return intoError(error)
      }
    }

    const requeueResult = await getRequeueResult()
    if (requeueResult instanceof Error) {
      logger.fatal(requeueResult, "Exception while trying to requeue a task")
      continue
    }

    const { announceCancel, requeue } = requeueResult
    if (
      timesRequeued &&
      /*
        Check if the task was requeued and got to execute, but it failed for
        some reason, in which case it will not be retried further; in
        comparison, it might have been requeued and not had a chance to execute
        due to other crash-inducing command being in front of it, thus it's not
        reasonable to avoid rescheduling this command if it's not his fault
      */
      timesRequeued === task.timesRequeuedSnapshotBeforeExecution
    ) {
      await announceCancel(
        `Command was rescheduled and failed to finish (check for task id ${id} in the logs); execution will not automatically be restarted further.`,
      )
    } else {
      try {
        await requeue()
      } catch (error) {
        const errorMessage = displayError(error)
        await announceCancel(
          `Caught exception while trying to reschedule the command; it will not be rescheduled further. Error message: ${errorMessage}.`,
        )
      }
    }
  }
}

export const getSendTaskMatrixResult = (
  matrix: MatrixClient,
  logger: Logger,
  task: ApiTask,
) => {
  return async (message: CommandOutput) => {
    try {
      await matrix.sendText(
        task.matrixRoom,
        `Task ID ${task.id} has finished with message "${
          message instanceof Error ? displayError(message) : message
        }"`,
      )
    } catch (rawError) {
      const error = intoError(rawError)
      logger.error(
        extractRequestError(error),
        "Caught error when sending Matrix message",
      )
    }
  }
}

export const cancelTask = async (ctx: Context, taskId: Task | string) => {
  const {
    taskDb: { db },
  } = ctx

  const task =
    typeof taskId === "string"
      ? await (async () => {
          return JSON.parse(await db.get(taskId)) as Task
        })()
      : taskId

  if (task.gitlab.pipeline !== null) {
    await cancelGitlabPipeline(ctx, task.gitlab.pipeline)
  }

  await db.del(task.id)
}
