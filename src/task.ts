import assert from "assert"
import cp from "child_process"
import { randomUUID } from "crypto"
import { parseISO } from "date-fns"
import fs from "fs"
import { extractRequestError, MatrixClient } from "matrix-bot-sdk"
import path from "path"
import { Probot } from "probot"

import { getSortedTasks } from "src/db"

import { getDeploymentsLogsMessage, prepareBranch } from "./core"
import {
  ExtendedOctokit,
  getPostPullRequestResult,
  updateComment,
} from "./github"
import { Logger } from "./logger"
import { ShellExecutor } from "./shell"
import { CommandExecutor, CommandOutput, Context, GitRef } from "./types"
import {
  displayDuration,
  displayError,
  escapeHtml,
  getNextUniqueIncrementalId,
  intoError,
} from "./utils"

type TaskBase<T> = {
  tag: T
  id: string
  queuedDate: string
  timesRequeued: number
  timesRequeuedSnapshotBeforeExecution: number
  timesExecuted: number
  commandDisplay: string
  execPath: string
  args: string[]
  env: Record<string, string>
  gitRef: GitRef
  repoPath: string
  requester: string
  gitlab: {
    pipeline: {
      id: number
      projectId: number
      status: "pending" | "cancelled"
    }
  } | null
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

export const queuedTasks: Map<
  string,
  { cancel: () => Promise<void> | void; task: Task }
> = new Map()

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
    updateProgress?: (message: string) => void
  },
) => {
  assert(
    queuedTasks.get(task.id) === undefined,
    `Attempted to queue task ${task.id} when it's already registered in the taskMap`,
  )

  if (task?.gitlab?.pipeline?.status === "cancelled") {
    return
  }

  const ctx = {
    ...parentCtx,
    logger: parentCtx.logger.child({ taskId: task.id }),
  }
  const { execPath, args, commandDisplay, repoPath } = task
  const {
    logger,
    taskDb,
    getFetchEndpoint,
    appName,
    repositoryCloneDirectory,
    cargoTargetDir,
  } = ctx
  const { db } = taskDb

  await db.put(task.id, JSON.stringify(task))

  let terminateTask: (() => Promise<void>) | undefined = undefined
  let activeProcess: cp.ChildProcess | undefined = undefined
  let taskIsAlive = true
  const terminate = async () => {
    if (terminateTask) {
      await terminateTask()
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
    logger.info(
      `Killed child with PID ${activeProcess.pid ?? "?"} (${commandDisplay})`,
    )

    activeProcess = undefined
  }

  queuedTasks.set(task.id, { task, cancel: terminate })

  const cancelledMessage = "Command was cancelled"

  const afterTaskRun = async (result: CommandOutput) => {
    const wasAlive = taskIsAlive

    await terminate()

    if (wasAlive) {
      void onResult(result)
    }
  }

  const runTask = async () => {
    try {
      let pipelineCtx = restoreGitlabPipelineContext(task)

      if (pipelineCtx === undefined) {
        await db.put(
          task.id,
          JSON.stringify({
            ...task,
            timesRequeuedSnapshotBeforeExecution: task.timesRequeued,
            timesExecuted: task.timesExecuted + 1,
          }),
        )

        if (taskIsAlive) {
          logger.info(
            { task, currentTaskQueue: await getSortedTasks(ctx) },
            `Starting task of ${commandDisplay}`,
          )
        } else {
          logger.info(task, "Task was cancelled before it could start")
          return cancelledMessage
        }

        const { run } = new ShellExecutor(ctx, {
          shouldTrackProgress: false,
          itemsToRedact: [],
          onChild: (createdChild) => {
            activeProcess = createdChild
          },
        })

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

        pipelineCtx = await runCommandInGitlabPipeline(execPath, args, task)

        task.gitlab = {
          pipeline: {
            id: pipelineCtx.id,
            projectId: pipelineCtx.projectId,
            status: "pending",
          },
        }
        await db.put(task.id, JSON.stringify(task))

        if (updateProgress) {
          updateProgress(
            `@${task.requester} ${pipelineCtx.pipelineUrl} was started`,
          )
        }
      }

      terminateTask = pipelineCtx.terminate
      await pipelineCtx.waitUntilPipelineFinished()

      return `${pipelineCtx.pipelineUrl} ${
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
  { id: taskId, matrixRoom, commandDisplay }: ApiTask,
) => {
  return async (message: CommandOutput) => {
    try {
      const fileName = `${taskId}-log.txt`
      const buf = message instanceof Error ? displayError(message) : message
      const messagePrefix = `Task ID ${taskId} has finished.`

      const lineCount = (buf.match(/\n/g) || "").length + 1
      if (lineCount < 128) {
        await matrix.sendHtmlText(
          matrixRoom,
          `${messagePrefix} Results will be displayed inline for <code>${escapeHtml(
            commandDisplay,
          )}</code>\n<hr>${escapeHtml(buf)}`,
        )
        return
      }

      const url = await matrix.uploadContent(
        Buffer.from(message instanceof Error ? displayError(message) : message),
        "text/plain",
        fileName,
      )
      await matrix.sendText(
        matrixRoom,
        `${messagePrefix} Results were uploaded as ${fileName} for ${commandDisplay}.`,
      )
      await matrix.sendMessage(matrixRoom, {
        msgtype: "m.file",
        body: fileName,
        url,
      })
    } catch (rawError) {
      const error = intoError(rawError)
      logger.error(
        extractRequestError(error),
        "Caught error when sending Matrix message",
      )
    }
  }
}
