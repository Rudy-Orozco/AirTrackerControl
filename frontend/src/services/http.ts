/**
 * Shared plumbing for the API services (services/api): every request can be
 * cancelled by its caller and gives up after a timeout.
 *
 * Imports nothing from the app, so any layer can use it.
 */

/** `signal`, also aborting after `timeoutMs`. */
export function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

/** The response, or an error if it isn't 2xx. */
export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await request(url, init)).json()
}

/** Downloads and decodes an image, ready to draw onto a canvas. */
export async function getImage(url: string, init?: RequestInit): Promise<HTMLImageElement> {
  const blobUrl = URL.createObjectURL(await (await request(url, init)).blob())
  try {
    const image = new Image()
    image.src = blobUrl
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}
