FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends openjdk-21-jre-headless && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src/ src/
COPY public/ public/
COPY templates/common/ defaults/common/
COPY entrypoint.sh entrypoint.sh

RUN chmod +x entrypoint.sh && \
    mkdir -p /app/data /app/servers /app/templates

VOLUME ["/app/data", "/app/servers", "/app/templates"]

EXPOSE 3000

RUN groupadd -r mcmanager && useradd -r -g mcmanager mcmanager && \
    chown -R mcmanager:mcmanager /app
USER mcmanager

ENTRYPOINT ["./entrypoint.sh"]
