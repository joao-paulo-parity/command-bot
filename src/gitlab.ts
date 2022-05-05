import EventEmitter from "events"
import fetch from "node-fetch"
import path from "path"
import yaml from "yaml"

import { CommandRunner, fsWriteFile } from "./shell"
import { Task, TaskGitlabContext } from "./task"
import { Context } from "./types"

type GitlabJobOptions = {
  image: string
  tags: string[]
}

export const runCommandInGitlabPipeline = async (
  ctx: Context,
  task: Task,
  jobOptions: GitlabJobOptions,
  {
    branchPrefix,
  }: {
    branchPrefix: string
  },
) => {
  const { execPath, args } = task
  await fsWriteFile(
    path.join(task.repoPath, ".gitlab-ci.yml"),
    yaml.stringify({
      command: {
        ...jobOptions,
        script: [`${execPath} ${args.join(" ")}`],
        variables: task.env,
      },
    }),
  )

  const { gitlab } = ctx
  const cmdRunner = new CommandRunner(ctx, {
    itemsToRedact: [gitlab.accessToken],
    shouldTrackProgress: false,
    cwd: task.repoPath,
  })

  const branchName = `${branchPrefix}/${
    "prNumber" in task.gitRef ? task.gitRef.prNumber : task.gitRef.branch
  }`
  await cmdRunner.run("git", ["branch", "-D", branchName], {
    testAllowedErrorMessage: (err) => {
      return err.endsWith("not found.")
    },
  })
  await cmdRunner.run("git", ["checkout", "-b", branchName])

  await cmdRunner.run("git", ["add", ".gitlab-ci.yml"])

  await cmdRunner.run("git", ["commit", "-m", "generate GitLab CI"])

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

  await cmdRunner.run("git", ["push", "-o", "ci.skip", gitlabRemote, "HEAD"])

  const createdPipeline = (await (
    await fetch(
      `https://${gitlab.domain}/api/v4/projects/${encodeURI(
        gitlabProjectPath,
      )}/pipeline?ref=${encodeURI(branchName)}`,
      { method: "POST", headers: { "PRIVATE-TOKEN": gitlab.accessToken } },
    )
  ).json()) as unknown as {
    id: number
    project_id: number
    web_url: string
  }

  return getLiveTaskGitlabContext(ctx, {
    pipeline: {
      id: createdPipeline.id,
      projectId: createdPipeline.project_id,
      status: "pending",
      webUrl: createdPipeline.web_url,
    },
  })
}

const cancelGitlabPipeline = async (
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
  if (!task.gitlab) {
    return
  }

  const { gitlab } = ctx

  const { pipeline } = task.gitlab
  const { status: pipelineStatus } = (await (
    await fetch(
      `https://${gitlab.domain}/api/v4/projects/${pipeline.projectId}/pipeline/${pipeline.id}`,
      { method: "POST", headers: { "PRIVATE-TOKEN": gitlab.accessToken } },
    )
  ).json()) as { status: string }
  switch (pipelineStatus) {
    case "canceled":
    case "failed": {
      return null
    }
  }

  return getLiveTaskGitlabContext(ctx, task.gitlab)
}

const getLiveTaskGitlabContext = (
  ctx: Context,
  taskGitlabCtx: TaskGitlabContext,
): TaskGitlabContext & {
  terminate: () => Promise<Error | undefined>
  waitUntilFinished: (
    taskTerminationEventChannel: EventEmitter,
  ) => Promise<string | Error>
} => {
  const { gitlab } = ctx
  const { pipeline } = taskGitlabCtx

  return {
    ...taskGitlabCtx,
    terminate: () => {
      return cancelGitlabPipeline(ctx, pipeline)
    },
    waitUntilFinished: (taskTerminationEventChannel) => {
      return Promise.race([
        new Promise<string>((resolve) => {
          taskTerminationEventChannel.on("finished", () => {
            return resolve("finished")
          })
        }),
        new Promise<string>((resolve, reject) => {
          const pollPipelineCompletion = async () => {
            try {
              const { status: pipelineStatus } = (await (
                await fetch(
                  `https://${gitlab.domain}/api/v4/projects/${pipeline.projectId}/pipeline/${pipeline.id}`,
                  {
                    method: "POST",
                    headers: { "PRIVATE-TOKEN": gitlab.accessToken },
                  },
                )
              ).json()) as { status: string }
              switch (pipelineStatus) {
                case "success":
                case "skipped":
                case "canceled":
                case "failed": {
                  return resolve(status)
                }
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
