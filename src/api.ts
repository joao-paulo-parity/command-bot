import Ajv from "ajv"
import bodyParser from "body-parser"
import { NextFunction, RequestHandler, Response } from "express"
import LevelErrors from "level-errors"
import path from "path"
import { Server } from "probot"

import {
  ApiTask,
  cancelTask,
  getNextTaskId,
  getSendTaskMatrixResult,
  queueTask,
  serializeTaskQueuedDate,
} from "./task"
import { Context } from "./types"

const getApiRoute = (route: string) => {
  return `/api${route}`
}

const taskRoute = "/task/:task_id"

const response = <T>(
  res: Response,
  next: NextFunction,
  code: number,
  body?: T,
) => {
  if (body === undefined) {
    res.status(code).send()
  } else {
    res.status(code).json(body)
  }
  next()
}

const errorResponse = <T>(
  res: Response,
  next: NextFunction,
  code: number,
  body?: T,
) => {
  response(res, next, code, body === undefined ? undefined : { error: body })
}

const jsonBodyParserMiddleware = bodyParser.json()

export const setupApi = (ctx: Context, server: Server) => {
  const { accessDb, matrix, repositoryCloneDirectory, logger } = ctx

  const apiError = (res: Response, next: NextFunction, error: unknown) => {
    const msg = "Failed to handle errors in API endpoint"
    logger.fatal(error, msg)
    errorResponse(res, next, 500, msg)
  }

  type JsonRequestHandlerParams = Parameters<
    RequestHandler<Record<string, unknown>, unknown, Record<string, unknown>>
  >
  const setupRoute = <T extends "post" | "get" | "delete" | "patch">(
    method: T,
    routePath: string,
    handler: (args: {
      req: JsonRequestHandlerParams[0]
      res: JsonRequestHandlerParams[1]
      next: JsonRequestHandlerParams[2]
      token: string
    }) => void | Promise<void>,
    { checkMasterToken }: { checkMasterToken?: boolean } = {},
  ) => {
    server.expressApp[method](
      getApiRoute(routePath),
      jsonBodyParserMiddleware,
      async (req, res, next) => {
        try {
          const token = req.headers["x-auth"]
          if (typeof token !== "string" || !token) {
            return errorResponse(res, next, 400, "Invalid auth token")
          }

          if (checkMasterToken && token !== ctx.masterToken) {
            return errorResponse(
              res,
              next,
              422,
              `Invalid ${token} for master token`,
            )
          }

          await handler({ req, res, next, token })
        } catch (error) {
          apiError(res, next, error)
        }
      },
    )
  }

  setupRoute("post", "/queue", async ({ req, res, next, token }) => {
    if (matrix === null) {
      return errorResponse(
        res,
        next,
        400,
        "Matrix is not configured for this server",
      )
    }

    let matrixRoom: string
    try {
      matrixRoom = await accessDb.db.get(token)
      if (!matrixRoom) {
        return errorResponse(res, next, 404)
      }
    } catch (error) {
      if (error instanceof LevelErrors.NotFoundError) {
        return errorResponse(res, next, 404)
      } else {
        return apiError(res, next, error)
      }
    }

    const ajv = new Ajv()
    const validateQueueEndpointInput = ajv.compile({
      type: "object",
      properties: {
        command: { type: "string" },
        job: {
          type: "object",
          properties: {
            tags: { type: "array", items: { type: "string" } },
            image: { type: "string" },
          },
          required: ["tags", "image"],
        },
        gitRef: {
          type: "object",
          properties: {
            contributor: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            branch: { type: "string" },
          },
          required: ["contributor", "owner", "repo", "branch"],
        },
      },
      required: ["command", "job", "gitRef"],
      additionalProperties: false,
    })
    const isInputValid = (await validateQueueEndpointInput(req.body)) as boolean
    if (!isInputValid) {
      return errorResponse(res, next, 400, validateQueueEndpointInput.errors)
    }

    type Payload = Pick<ApiTask, "gitRef" | "command"> & {
      job: ApiTask["gitlab"]["job"]
    }
    const { command, job, gitRef } = req.body as Payload

    const taskId = getNextTaskId()
    const queuedDate = new Date()

    const task: ApiTask = {
      id: taskId,
      tag: "ApiTask",
      timesRequeued: 0,
      timesRequeuedSnapshotBeforeExecution: 0,
      timesExecuted: 0,
      gitRef,
      matrixRoom,
      repoPath: path.join(repositoryCloneDirectory, gitRef.repo),
      queuedDate: serializeTaskQueuedDate(queuedDate),
      requester: matrixRoom,
      command,
      gitlab: { job, pipeline: null },
    }

    await queueTask(ctx, task, {
      onResult: getSendTaskMatrixResult(matrix, logger, task),
    })

    response(res, next, 201, {
      task,
      info: `Command queued. Send a DELETE request to ${getApiRoute(
        taskRoute,
      )} for cancelling`,
    })
  })

  setupRoute("delete", taskRoute, async ({ req, res, next }) => {
    const { task_id: taskId } = req.params
    if (typeof taskId !== "string" || !taskId) {
      return errorResponse(res, next, 403, "Invalid task_id")
    }

    await cancelTask(ctx, taskId)

    response(res, next, 204)
  })

  setupRoute(
    "post",
    "/access",
    async ({ req, res, next }) => {
      const { token: requesterToken, matrixRoom } = req.body
      if (typeof requesterToken !== "string" || !requesterToken) {
        return errorResponse(res, next, 400, "Invalid requesterToken")
      }
      if (typeof matrixRoom !== "string" || !matrixRoom) {
        return errorResponse(res, next, 400, "Invalid matrixRoom")
      }

      try {
        if (await accessDb.db.get(requesterToken)) {
          return errorResponse(res, next, 422, "requesterToken already exists")
        }
      } catch (error) {
        if (!(error instanceof LevelErrors.NotFoundError)) {
          return apiError(res, next, error)
        }
      }

      await accessDb.db.put(requesterToken, matrixRoom)
      response(res, next, 201)
    },
    { checkMasterToken: true },
  )

  setupRoute("patch", "/access", async ({ req, res, next, token }) => {
    const { matrixRoom } = req.body
    if (typeof matrixRoom !== "string" || !matrixRoom) {
      return errorResponse(res, next, 400, "Invalid matrixRoom")
    }

    try {
      const value = await accessDb.db.get(token)
      if (!value) {
        return errorResponse(res, next, 404)
      }
    } catch (error) {
      if (error instanceof LevelErrors.NotFoundError) {
        return errorResponse(res, next, 404)
      } else {
        return apiError(res, next, error)
      }
    }

    await accessDb.db.put(token, matrixRoom)
    response(res, next, 204)
  })

  setupRoute("delete", "/access", async ({ res, next, token }) => {
    try {
      const value = await accessDb.db.get(token)
      if (!value) {
        return errorResponse(res, next, 404)
      }
    } catch (error) {
      if (error instanceof LevelErrors.NotFoundError) {
        return errorResponse(res, next, 404)
      } else {
        return apiError(res, next, error)
      }
    }

    await accessDb.db.put(token, "")
    response(res, next, 204)
  })
}
