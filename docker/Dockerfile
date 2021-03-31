FROM python:3-slim

COPY . /opt/jolt/dashboard
RUN pip3 install dash dash-devices quart quart_compress
ENTRYPOINT ["python", "/opt/jolt/dashboard/dashboard.py"]
CMD []
