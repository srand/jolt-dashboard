import requests_unixsocket
import aiohttp

async def logs_docker(worker):
    worker = worker.rsplit(".")[-1].rsplit("-")[-1]
    conn = aiohttp.UnixConnector(path='/var/run/docker.sock')
    session = aiohttp.ClientSession(connector=conn)
    async with session.get(f'http+unix://%2Fvar%2Frun%2Fdocker.sock/tasks/{worker}/logs?stdout=true&follow=true') as r:
        if r.status == 200:
            async for chunk, _ in r.content.iter_chunks():
                yield chunk
            return

    async with session.get(f'http+unix://%2Fvar%2Frun%2Fdocker.sock/container/{worker}/logs?stdout=true&stderr=true&follow=true') as r:
        if r.status == 200:
            async for chunk, _ in r.content.iter_chunks():
                yield chunk


logs = logs_docker
