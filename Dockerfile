FROM eclipse-temurin:21-jre AS jre

FROM node:20-slim

ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=$JAVA_HOME/bin:$PATH
COPY --from=jre $JAVA_HOME $JAVA_HOME

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        fontconfig \
        ca-certificates \
        p11-kit \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

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
