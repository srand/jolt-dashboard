FROM python:3-slim
ENV RELEASE=1
RUN pip3 install dash dash-devices quart quart_compress
ENTRYPOINT ["python", "/opt/jolt/dashboard/dashboard.py"]
CMD []
COPY . /opt/jolt/
