FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends wget apt-transport-https gnupg && \
    mkdir -p /etc/apt/keyrings && \
    wget -qO - https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb $(. /etc/os-release && echo $VERSION_CODENAME) main" > /etc/apt/sources.list.d/adoptium.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends temurin-21-jre && \
    apt-get purge -y wget apt-transport-https gnupg && \
    apt-get autoremove -y && \
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
