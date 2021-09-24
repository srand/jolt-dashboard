FROM python:3-slim
ENV RELEASE=true
EXPOSE 80
RUN pip3 install dash dash_daq requests_unixsocket aiohttp
ENTRYPOINT ["python", "/opt/jolt/dashboard/dashboard.py"]
CMD []
COPY . /opt/jolt/
