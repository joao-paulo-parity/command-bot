import { spawn, ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import fs from "fs"
import path from "path"
import { promisify } from "util"
import { Logger } from "./logger"

import { CommandExecutor, CommandOutput, Context, ToString } from "./types"
import { displayCommand, intoError, redact } from "./utils"

export const fsExists = promisify(fs.exists)
export const fsReadFile = promisify(fs.readFile)
export const fsWriteFile = promisify(fs.writeFile)
const fsRmdir = promisify(fs.rmdir)
const fsMkdir = promisify(fs.mkdir)
const fsUnlink = promisify(fs.unlink)

export const ensureDir = async (dir: string) => {
  if (!(await fsExists(dir))) {
    await fsMkdir(dir, { recursive: true })
  }
  return dir
}

const removeDir = async (dir: string) => {
  if (!(await fsExists(dir))) {
    await fsRmdir(dir, { recursive: true })
  }
  return dir
}

export const initDatabaseDir = async (dir: string) => {
  dir = await ensureDir(dir)
  const lockPath = path.join(dir, "LOCK")
  if (await fsExists(lockPath)) {
    await fsUnlink(lockPath)
  }
  return dir
}

type ShellExecutorConfiguration = {
  itemsToRedact: string[]
  shouldTrackProgress: boolean
  cwd?: string
  onChild?: (child: ChildProcess) => void
}
export class ShellExecutor {
  private logger: Logger

  constructor(
    ctx: Context,
    private configuration: {
      itemsToRedact: string[]
      shouldTrackProgress: boolean
      cwd?: string
      onChild?: (child: ChildProcess) => void
    },
  ) {
    this.logger = ctx.logger.child({ commandId: randomUUID() })
  }

  async run(
    execPath: string,
    args: string[],
    {
      allowedErrorCodes,
      testAllowedErrorMessage,
    }: {
      allowedErrorCodes?: number[]
      testAllowedErrorMessage?: (stderr: string) => boolean
    } = {},
  ) {
    const { logger } = this
    return new Promise<string | Error>((resolve, reject) => {
      const { cwd, itemsToRedact, onChild, shouldTrackProgress } =
        this.configuration

      const commandDisplayed = displayCommand({ execPath, args, itemsToRedact })
      logger.info(`Executing command ${commandDisplayed}`)

      const child = spawn(execPath, args, { cwd, stdio: "pipe" })
      if (onChild) {
        onChild(child)
      }

      let stdoutBuf = ""
      let stderrBuf = ""
      const getStreamHandler = function (channel: "stdout" | "stderr") {
        return function (data: { toString: () => string }) {
          const str = redact(data.toString(), itemsToRedact)
          const strTrim = str.trim()

          if (strTrim && shouldTrackProgress) {
            logger.info(strTrim, channel)
          }

          switch (channel) {
            case "stdout": {
              stdoutBuf += str
              break
            }
            case "stderr": {
              stderrBuf += str
              break
            }
            default: {
              const exhaustivenessCheck: never = channel
              // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
              throw new Error(`Not exhaustive: ${exhaustivenessCheck}`)
            }
          }
        }
      }

      child.stdout.on("data", getStreamHandler("stdout"))
      child.stderr.on("data", getStreamHandler("stderr"))

      child.on("close", async (exitCode, signal) => {
        logger.info(
          `Process finished with exit code ${exitCode ?? "??"}${
            signal ? `and signal ${signal}` : ""
          }`,
        )
        if (signal) {
          resolve(new Error(`Process got terminated by signal ${signal}`))
        } else if (exitCode) {
          const stderr = redact(stderrBuf.trim(), itemsToRedact)
          if (
            allowedErrorCodes?.includes(exitCode) ||
            (testAllowedErrorMessage !== undefined &&
              testAllowedErrorMessage(stderr))
          ) {
            logger.info(`Finished command ${commandDisplayed}`)
            resolve(redact(stdoutBuf.trim(), itemsToRedact))
          } else {
            reject(new Error(stderr))
          }
        } else {
          resolve(redact(stdoutBuf.trim(), itemsToRedact))
        }
      })
    })
  }
}
