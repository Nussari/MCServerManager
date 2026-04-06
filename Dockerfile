FROM eclipse-temurin:21-jre AS jre21
FROM eclipse-temurin:25-jre AS jre25

FROM node:20-slim

COPY --from=jre21 /opt/java/openjdk /opt/java/21
COPY --from=jre25 /opt/java/openjdk /opt/java/25

ENV JAVA_HOME=/opt/java/21
ENV PATH=$JAVA_HOME/bin:$PATH
ENV JAVA_21=/opt/java/21/bin/java
ENV JAVA_25=/opt/java/25/bin/java

# System libraries the JRE dynamically links against.
# These MUST be present — the JRE is copied from another image so its
# shared library deps are not automatically satisfied. Missing libs
# cause silent memory corruption → SIGSEGV in GC threads.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        fontconfig \
        libfreetype6 \
        ca-certificates \
        p11-kit \
        tzdata \
        libnss3 \
        libnspr4 \
        libatomic1 \
        zlib1g \
        libstdc++6 \
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
