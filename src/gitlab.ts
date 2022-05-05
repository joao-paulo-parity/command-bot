import fetch from "node-fetch"
import yaml from "yaml"
import { Task } from "./task"
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
  }

  return { id: createdPipeline.id, projectId: createdPipeline.project_id }
}
