import { MatrixClient } from "matrix-bot-sdk"
import { Probot } from "probot"
import { EmitterWebhookEventName as WebhookEvents } from "@octokit/webhooks/dist-types/types"
import type { WebhookEventMap } from "@octokit/webhooks-types";

import type { AccessDB, TaskDB } from "./db"
import { Logger } from "./logger"

export type PullRequestParams = {
  owner: string
  repo: string
  pull_number: number
}

type GitRef = {
  contributor: string
  owner: string
  repo: string
  branch: string
}

type TaskBase<T> = {
  tag: T
  handleId: string
  version: string
  timesRequeued: number
  timesRequeuedSnapshotBeforeExecution: number
  timesExecuted: number
  commandDisplay: string
  execPath: string
  args: string[]
  env: Record<string, string>
  gitRef: GitRef
  repoPath: string
}

export type PullRequestTask = TaskBase<"PullRequestTask"> &
  PullRequestParams & {
    commentId: number
    installationId: number
    requester: string
  }

export type ApiTask = TaskBase<"ApiTask"> & {
  matrixRoom: string
}

export type Task = PullRequestTask | ApiTask

export type CommandOutput = Error | string

type TaskIdParseResult = { date: Date; suffix?: string } | Error
export type State = {
  appName: string
  version: string
  bot: Probot
  taskDb: TaskDB
  accessDb: AccessDB
  getFetchEndpoint: (
    installationId: number | null,
  ) => Promise<{ token: string; url: string }>
  log: (str: string) => void
  allowedOrganizations: number[]
  logger: Logger
  repositoryCloneDirectory: string
  deployment: { environment: string; container: string } | undefined
  matrix: MatrixClient | null
  masterToken: string | null
  getUniqueId: () => string
  getTaskId: () => string
  parseTaskId: (id: string) => TaskIdParseResult
  nodesAddresses: Record<string, string>
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

export type GetCommandOptions = { baseEnv: Record<string, string> }

export type Octokit = Awaited<ReturnType<Probot["auth"]>>

export type ProbotOnEvents = Exclude<
  keyof WebhookEventMap,
  | "branch_protection_rule"
  | "branch_protection_rule.created"
  | "branch_protection_rule.deleted"
  | "branch_protection_rule.edited"
  | "pull_request_review_thread"
  | "pull_request_review_thread.resolved"
  | "pull_request_review_thread.unresolved"
  | "workflow_job"
  | "workflow_job.completed"
  | "workflow_job.in_progress"
  | "workflow_job.queued"
  | "workflow_job.started"
>
