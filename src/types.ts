import { Probot } from "probot"

import type { DB } from "./db"
import { Logger } from "./logger"

export type PullRequestParams = {
  owner: string
  repo: string
  pull_number: number
}

export type PrepareBranchParams = {
  contributor: string
  owner: string
  repo: string
  branch: string
  repoPath: string
}

export type PullRequestTask = PullRequestParams & {
  installationId: number
  requester: string
  execPath: string
  args: string[]
  env: Record<string, string>
  prepareBranchParams: PrepareBranchParams
  commentId: number
  version: string
  commandDisplay: string
  timesRequeued: number
  timesRequeuedSnapshotBeforeExecution: number
  timesExecuted: number
}

export type CommandOutput = Error | string

export type State = {
  version: string
  bot: Probot
  db: DB
  clientId: string
  clientSecret: string
  appId: number
  getFetchEndpoint: (
    installationId: number,
  ) => Promise<{ token: string; url: string }>
  log: (str: string) => void
  botMentionPrefix: string
  nodesAddresses: Record<string, string>
  allowedOrganizations: number[]
  logger: Logger
  repositoryCloneDirectory: string
  deployment: { environment: string; container: string } | undefined
}

export class PullRequestError {
  constructor(
    public params: PullRequestParams,
    public comment: {
      body: string
      commentId?: number
      requester?: string
    },
  ) {}
}
