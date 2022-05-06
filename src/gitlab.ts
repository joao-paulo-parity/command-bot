import EventEmitter from "events"
import fetch from "node-fetch"
import path from "path"
import yaml from "yaml"
import Joi from "joi"

import { CommandRunner, fsWriteFile } from "./shell"
import { Task, TaskGitlabPipeline, taskTerminationEvent } from "./task"
import { Context } from "./types"
import { validatedFetch } from "./utils"

const runCommandBranchPrefix = "ci-exec"

export const runCommandInGitlabPipeline = async (ctx: Context, task: Task) => {
  const { logger } = ctx

  await fsWriteFile(
    path.join(task.repoPath, ".gitlab-ci.yml"),
    yaml.stringify({ command: { ...task.gitlab.job, script: [task.command] } }),
  )

  const { gitlab } = ctx
  const cmdRunner = new CommandRunner(ctx, {
    itemsToRedact: [gitlab.accessToken],
    shouldTrackProgress: false,
    cwd: task.repoPath,
  })

  const branchName = `${runCommandBranchPrefix}/${
    "prNumber" in task.gitRef ? task.gitRef.prNumber : task.gitRef.branch
  }`
  await cmdRunner.run("git", ["branch", "-D", branchName], {
    testAllowedErrorMessage: (err) => {
      return err.endsWith("not found.")
    },
  })
  await cmdRunner.run("git", ["checkout", "-b", branchName])

  await cmdRunner.run("git", ["add", ".gitlab-ci.yml"])

  await cmdRunner.run("git", ["commit", "-m", task.command])

  const gitlabRemote = "gitlab"
  const gitlabProjectPath = `${gitlab.pushNamespace}/${task.gitRef.repo}`

  await cmdRunner.run("git", ["remote", "remove", gitlabRemote], {
    testAllowedErrorMessage: (err) => {
      return err.includes("No such remote:")
    },
  })

  await cmdRunner.run("git", [
    "remote",
    "add",
    gitlabRemote,
    `https://token:${gitlab.accessToken}@${gitlab.domain}/${gitlabProjectPath}.git`,
  ])

  await cmdRunner.run("git", [
    "push",
    "--force",
    "-o",
    "ci.skip",
    gitlabRemote,
    "HEAD",
  ])

  const pipeline = await validatedFetch<{
    id: number
    project_id: number
  }>(
    fetch(
      `https://${gitlab.domain}/api/v4/projects/${encodeURIComponent(
        gitlabProjectPath,
      )}/pipeline?ref=${encodeURIComponent(branchName)}`,
      { method: "POST", headers: { "PRIVATE-TOKEN": gitlab.accessToken } },
    ),
    Joi.object().keys({
      id: Joi.number().required(),
      project_id: Joi.number().required(),
    }),
  )
  logger.info(pipeline, `Created pipeline for task ${task.id}`)

  const [job] = await validatedFetch<
    [
      {
        id: number
        web_url: string
      },
    ]
  >(
    fetch(
      `https://${gitlab.domain}/api/v4/projects/${pipeline.project_id}/pipeline/${pipeline.id}/jobs`,
      { headers: { "PRIVATE-TOKEN": gitlab.accessToken } },
    ),
    Joi.array().items(
      Joi.object().keys({
        id: Joi.number().required(),
        web_url: Joi.string().required(),
      }),
    ),
  )
  logger.info(job, `Created job for task ${task.id}`)

  return getLiveTaskGitlabContext(ctx, {
    id: pipeline.id,
    projectId: pipeline.project_id,
    jobWebUrl: job.web_url,
  })
}

export const cancelGitlabPipeline = async (
  { gitlab }: Context,
  { id, projectId }: { id: number; projectId: number },
) => {
  const response = await fetch(
    `https://${gitlab.domain}/api/v4/projects/${projectId}/pipeline/${id}/cancel`,
    { method: "POST", headers: { "PRIVATE-TOKEN": gitlab.accessToken } },
  )

  if (response.ok) {
    return
  }

  return new Error(await response.text())
}

export const restoreTaskGitlabContext = async (ctx: Context, task: Task) => {
  if (!task.gitlab.pipeline) {
    return
  }

  const { gitlab } = ctx
  const { pipeline } = task.gitlab

  const { status: pipelineStatus } = await validatedFetch<{
    status: string
  }>(
    fetch(
      `https://${gitlab.domain}/api/v4/projects/${pipeline.projectId}/pipeline/${pipeline.id}`,
      { headers: { "PRIVATE-TOKEN": gitlab.accessToken } },
    ),
    Joi.object().keys({ status: Joi.string().required() }),
  )
  if (isPipelineFinishedStatus(pipelineStatus)) {
    return null
  }

  return getLiveTaskGitlabContext(ctx, task.gitlab.pipeline)
}

export const isPipelineFinishedStatus = (status: string) => {
  switch (status) {
    case "success":
    case "skipped":
    case "canceled":
    case "failed": {
      return true
    }
  }
}

const getLiveTaskGitlabContext = (
  ctx: Context,
  pipeline: TaskGitlabPipeline,
): TaskGitlabPipeline & {
  terminate: () => Promise<Error | undefined>
  waitUntilFinished: (taskEventChannel: EventEmitter) => Promise<unknown>
} => {
  const { gitlab } = ctx
  return {
    ...pipeline,
    terminate: () => {
      return cancelGitlabPipeline(ctx, pipeline)
    },
    waitUntilFinished: (taskEventChannel) => {
      return Promise.race([
        new Promise<void>((resolve) => {
          taskEventChannel.on(taskTerminationEvent, resolve)
        }),
        new Promise<void>((resolve, reject) => {
          const pollPipelineCompletion = async () => {
            try {
              const { status: pipelineStatus } = await validatedFetch<{
                status: string
              }>(
                fetch(
                  `https://${gitlab.domain}/api/v4/projects/${pipeline.projectId}/pipeline/${pipeline.id}`,
                  { headers: { "PRIVATE-TOKEN": gitlab.accessToken } },
                ),
                Joi.object().keys({ status: Joi.string().required() }),
              )

              if (isPipelineFinishedStatus(pipelineStatus)) {
                return resolve()
              }

              setTimeout(() => {
                void pollPipelineCompletion()
              }, 32768)
            } catch (error) {
              reject(error)
            }
          }
          void pollPipelineCompletion()
        }),
      ])
    },
  }
}
