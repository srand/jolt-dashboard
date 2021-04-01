FROM python:3-slim
ENV RELEASE=true
EXPOSE 80
RUN pip3 install dash dash_daq dash-devices quart quart_compress
ENTRYPOINT ["python", "/opt/jolt/dashboard/dashboard.py"]
CMD []
COPY . /opt/jolt/
