FROM debian:bookworm-slim
ENV GIN_MODE=release
ENV PORT=80
ENV JOLT_SCHEDULER_URI=tcp://jolt-scheduler:9090
EXPOSE 80
ENTRYPOINT ["/opt/jolt/bin/backend"]
WORKDIR "/opt/jolt"
CMD []
COPY . /opt/jolt/
