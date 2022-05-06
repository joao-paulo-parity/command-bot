import assert from "assert"

import { botPullRequestCommentMention } from "./bot"
import { ExtendedOctokit, isOrganizationMember } from "./github"
import { CommandRunner } from "./shell"
import { Task } from "./task"
import { Context } from "./types"

const parseArg = (prev: string, option: string, arg: string) => {
  if (arg.startsWith(`${option}=`)) {
    return arg.slice(`${option}=`.length)
  } else if (arg === option) {
    return true
  }
}

export const parsePullRequestBotCommandLine = (commandLine: string) => {
  commandLine = commandLine.trim()

  if (!commandLine.startsWith("/run ")) {
    return
  }

  commandLine = commandLine.slice("/run ".length).trim()

  const startOfArgs = " $ "
  const indexOfArgsStart = commandLine.indexOf(startOfArgs)
  if (indexOfArgsStart) {
    return new Error(`Could not find start of arguments ("${startOfArgs}")`)
  }

  const commandLinePart = commandLine.slice(
    indexOfArgsStart + startOfArgs.length,
  )

  const botOptionsLinePart = commandLine.slice(0, indexOfArgsStart)
  const botOptionsTokens = botOptionsLinePart.split(" ").filter((value) => {
    botOptionsLinePart
    return !!value
  })

  let activeOption: string | undefined = undefined
  const options: Map<string, string[]> = new Map()
  for (const tok of botOptionsTokens) {
    if (tok[0] === "-") {
      activeOption = tok
    } else if (activeOption) {
      options.set(activeOption, [...(options.get(activeOption) ?? []), tok])
    } else {
      return new Error(`Expected command option, got ${tok}`)
    }
  }

  const jobTags = (options.get("-t") ?? []).concat(options.get("--tag") ?? [])

  if (jobTags?.length ?? 0 === 0) {
    return new Error(
      `Unable to parse job tags from command line ${botOptionsLinePart}`,
    )
  }

  return { jobTags, command: commandLinePart.trim() }
}

export const getDeploymentsLogsMessage = ({ deployment }: Context) => {
  return deployment === undefined
    ? ""
    : `The logs for this command should be available on Grafana for the data source \`loki.${deployment.environment}\` and query \`{container=~"${deployment.container}"}\``
}

export const isRequesterAllowed = async (
  ctx: Context,
  octokit: ExtendedOctokit,
  username: string,
) => {
  const { allowedOrganizations } = ctx

  for (const organizationId of allowedOrganizations) {
    if (
      await isOrganizationMember(ctx, { organizationId, username, octokit })
    ) {
      return true
    }
  }

  return false
}

export const prepareBranch = async function* (
  ctx: Context,
  { repoPath, gitRef: { contributor, owner, repo, branch } }: Task,
  {
    getFetchEndpoint,
  }: {
    getFetchEndpoint: () => Promise<{ token: string; url: string }>
  },
) {
  const { token, url } = await getFetchEndpoint()

  const cmdRunner = new CommandRunner(ctx, {
    itemsToRedact: [token],
    shouldTrackProgress: false,
  })

  yield cmdRunner.run("mkdir", ["-p", repoPath])

  const repoCmdRunner = new CommandRunner(ctx, {
    itemsToRedact: [token],
    shouldTrackProgress: false,
    cwd: repoPath,
  })

  // Clone the repository if it does not exist
  yield repoCmdRunner.run(
    "git",
    ["clone", "--quiet", `${url}/${owner}/${repo}`, repoPath],
    {
      testAllowedErrorMessage: (err) => {
        return err.endsWith("already exists and is not an empty directory.")
      },
    },
  )

  // Clean up garbage files before checkout
  yield repoCmdRunner.run("git", ["add", "."])
  yield repoCmdRunner.run("git", ["reset", "--hard"])

  // Check out to the detached head so that any branch can be deleted
  const out = await repoCmdRunner.run("git", ["rev-parse", "HEAD"])
  if (out instanceof Error) {
    return out
  }
  const detachedHead = out.trim()
  yield repoCmdRunner.run("git", ["checkout", "--quiet", detachedHead], {
    testAllowedErrorMessage: (err) => {
      // Why the hell is this not printed to stdout?
      return err.startsWith("HEAD is now at")
    },
  })

  const prRemote = "pr"
  yield repoCmdRunner.run("git", ["remote", "remove", prRemote], {
    testAllowedErrorMessage: (err) => {
      return err.includes("No such remote:")
    },
  })

  yield repoCmdRunner.run("git", [
    "remote",
    "add",
    prRemote,
    `${url}/${contributor}/${repo}.git`,
  ])

  yield repoCmdRunner.run("git", ["fetch", "--quiet", prRemote, branch])

  yield repoCmdRunner.run("git", ["branch", "-D", branch], {
    testAllowedErrorMessage: (err) => {
      return err.endsWith("not found.")
    },
  })

  yield repoCmdRunner.run("git", [
    "checkout",
    "--quiet",
    "--track",
    `${prRemote}/${branch}`,
  ])
}
