FROM debian:bookworm-slim
ENV GIN_MODE=release
ENV PORT=80
EXPOSE 80
ENTRYPOINT ["/opt/jolt/bin/backend"]
WORKDIR "/opt/jolt"
CMD []
COPY . /opt/jolt/
