import { createAppAuth } from "@octokit/auth-app"
import { Octokit } from "@octokit/rest"
import assert from "assert"
import fs from "fs"
import path from "path"
import { Probot, run } from "probot"

import { botMentionPrefix } from "src/constants"
import { getDb, getSortedTasks } from "src/db"

import { queue } from "./executor"
import { Logger } from "./logger"
import { AppState } from "./types"
import { getPostPullRequestResult, getPullRequestHandleId } from "./utils"
import { getWebhooksHandlers, setupEvent } from "./webhook"

assert(process.env.APP_ID)
const appId = parseInt(process.env.APP_ID)
assert(appId)

assert(process.env.PRIVATE_KEY_BASE64)
process.env.PRIVATE_KEY = Buffer.from(
  process.env.PRIVATE_KEY_BASE64,
  "base64",
).toString()
assert(process.env.PRIVATE_KEY)
const privateKey = process.env.PRIVATE_KEY

assert(process.env.CLIENT_ID)
const clientId = process.env.CLIENT_ID

assert(process.env.CLIENT_SECRET)
const clientSecret = process.env.CLIENT_SECRET

const setupProbot = async function (state: AppState) {
  const { bot, logger } = state

  const { onIssueCommentCreated } = getWebhooksHandlers(state)
  setupEvent(bot, "issue_comment.created", onIssueCommentCreated, logger)
}

const requeueUnterminated = async function ({
  getFetchEndpoint,
  db,
  version,
  logger,
  bot,
}: AppState) {
  // Items which are not from this version still remaining in the database are
  // deemed unterminated.
  const unterminatedItems = await getSortedTasks(db, {
    match: { version, isInverseMatch: true },
  })

  for (const { taskData, id } of unterminatedItems) {
    await db.del(id)

    const octokit = await (
      bot.auth as (installationId?: number) => Promise<Octokit>
    )(taskData.installationId)
    const handleId = getPullRequestHandleId(taskData)

    logger.info(`Requeuing ${JSON.stringify(taskData)}`)
    await queue({
      handleId,
      getFetchEndpoint,
      db,
      logger,
      taskData,
      onResult: getPostPullRequestResult({ taskData, octokit, handleId }),
    })
  }
}

const main = async function (bot: Probot) {
  const version = new Date().toISOString()

  assert(process.env.ROCOCO_WEBSOCKET_ADDRESS)
  assert(process.env.WESTEND_WEBSOCKET_ADDRESS)
  assert(process.env.POLKADOT_WEBSOCKET_ADDRESS)
  assert(process.env.KUSAMA_WEBSOCKET_ADDRESS)
  const nodesAddresses = {
    rococo: process.env.ROCOCO_WEBSOCKET_ADDRESS,
    westend: process.env.WESTEND_WEBSOCKET_ADDRESS,
    polkadot: process.env.POLKADOT_WEBSOCKET_ADDRESS,
    kusama: process.env.KUSAMA_WEBSOCKET_ADDRESS,
  }

  const allowedOrganizations = (process.env.ALLOWED_ORGANIZATIONS ?? "")
    .split(",")
    .filter(function (value) {
      return value.length !== 0
    })
    .map(function (value) {
      const parsedValue = parseInt(value)
      assert(parsedValue)
      return parsedValue
    })
  assert(allowedOrganizations.length)

  assert(process.env.DB_PATH)
  const lockPath = path.join(process.env.DB_PATH, "LOCK")
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath)
  }
  const db = getDb(process.env.DB_PATH)

  const authInstallation = createAppAuth({
    appId,
    privateKey,
    clientId,
    clientSecret,
  })

  const getFetchEndpoint = async function (installationId: number) {
    const token = (
      await authInstallation({
        type: "installation",
        installationId,
      })
    ).token

    const url = `https://x-access-token:${token}@github.com`

    return { url, token }
  }

  const logger = new Logger({ name: "app" })
  const appState: AppState = {
    bot,
    db,
    appId,
    getFetchEndpoint,
    clientSecret,
    clientId,
    log: bot.log,
    botMentionPrefix,
    version,
    nodesAddresses,
    allowedOrganizations,
    logger,
  }

  await requeueUnterminated(appState)
  setupProbot(appState)

  logger.info("Probot has started!")
}

run(main)
