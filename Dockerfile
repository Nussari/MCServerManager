FROM eclipse-temurin:21-jre AS jre21
FROM eclipse-temurin:25-jre AS jre25

FROM node:20-slim

COPY --from=jre21 /opt/java/openjdk /opt/java/21
COPY --from=jre25 /opt/java/openjdk /opt/java/25

ENV JAVA_HOME=/opt/java/25
ENV PATH=$JAVA_HOME/bin:$PATH
ENV JAVA_21=/opt/java/21/bin/java
ENV JAVA_25=/opt/java/25/bin/java

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
