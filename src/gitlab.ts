import EventEmitter from "events"
import fetch from "node-fetch"
import path from "path"
import yaml from "yaml"

import { CommandRunner, fsWriteFile } from "./shell"
import { Task, TaskGitlabPipeline } from "./task"
import { Context } from "./types"

const runCommandBranchPrefix = "ci-exec/"

export const runCommandInGitlabPipeline = async (ctx: Context, task: Task) => {
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

  await cmdRunner.run("git", [
    "push",
    "--force",
    "-o",
    "ci.skip",
    gitlabRemote,
    "HEAD",
  ])

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
    id: createdPipeline.id,
    projectId: createdPipeline.project_id,
    webUrl: createdPipeline.web_url,
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
  if (!task.gitlab.pipeline) {
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

  return getLiveTaskGitlabContext(ctx, task.gitlab.pipeline)
}

const getLiveTaskGitlabContext = (
  ctx: Context,
  pipeline: TaskGitlabPipeline,
): TaskGitlabPipeline & {
  terminate: () => Promise<Error | undefined>
  waitUntilFinished: (
    taskTerminationEventChannel: EventEmitter,
  ) => Promise<string | Error>
} => {
  const { gitlab } = ctx
  return {
    ...pipeline,
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
