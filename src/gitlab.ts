import fetch from "node-fetch"
import yaml from "yaml"
import { Task, TaskGitlabContext } from "./task"
import { Context } from "./types"
import path from "path"
import { fsWriteFile, ShellExecutor } from "./shell"

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
  const { run } = new ShellExecutor(ctx, {
    itemsToRedact: [gitlab.accessToken],
    shouldTrackProgress: false,
    cwd: task.repoPath,
  })

  const branchName = `${branchPrefix}/${
    "prNumber" in task.gitRef ? task.gitRef.prNumber : task.gitRef.branch
  }`
  await run("git", ["branch", "-D", branchName], {
    testAllowedErrorMessage: (err) => {
      return err.endsWith("not found.")
    },
  })
  await run("git", ["checkout", "-b", branchName])

  await run("git", ["add", ".gitlab-ci.yml"])

  await run("git", ["commit", "-m", "generate GitLab CI"])

  const gitlabRemote = "gitlab"
  const gitlabProjectPath = `${gitlab.pushNamespace}/${task.gitRef.repo}`

  await run("git", ["remote", "remove", gitlabRemote], {
    testAllowedErrorMessage: (err) => {
      return err.includes("No such remote:")
    },
  })

  await run("git", [
    "remote",
    "add",
    gitlabRemote,
    `https://token:${gitlab.accessToken}@${gitlab.domain}/${gitlabProjectPath}.git`,
  ])

  await run("git", ["push", "-o", "ci.skip", gitlabRemote, "HEAD"])

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

  return getTaskGitlabContext(ctx, {
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

  return getTaskGitlabContext(ctx, task.gitlab)
}

export const getTaskGitlabContext = async (
  ctx: Context,
  taskGitlabContext: TaskGitlabContext,
): Promise<TaskGitlabContext & { terminate: () => Promise<boolean> }> => {
  return {
    ...taskGitlabContext,
    terminate: () => cancelGitlabPipeline(ctx, taskGitlabContext.pipeline),
  }
}
