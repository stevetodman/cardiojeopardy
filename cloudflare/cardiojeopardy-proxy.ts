const UPSTREAM = 'https://stevetodman-cardiojeopardy.hf.space'

export default {
  fetch(request: Request): Promise<Response> {
    const upstreamUrl = new URL(request.url)
    upstreamUrl.protocol = 'https:'
    upstreamUrl.hostname = new URL(UPSTREAM).hostname
    upstreamUrl.port = ''

    const proxyRequest = new Request(upstreamUrl, request)
    proxyRequest.headers.set('Host', upstreamUrl.hostname)
    proxyRequest.headers.set('X-Forwarded-Host', new URL(request.url).host)
    proxyRequest.headers.set('X-Forwarded-Proto', 'https')

    return fetch(proxyRequest)
  },
}
