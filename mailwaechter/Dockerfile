ARG BUILD_FROM
FROM ${BUILD_FROM}

# Node 22 aus Alpine 3.22 - die Prüfregeln sind JavaScript (ESM)
RUN apk add --no-cache nodejs npm

WORKDIR /opt/mailwaechter

# imapflow ist reines JavaScript - kein Compiler im Abbild nötig
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY app ./app

# Syntaxfehler sollen den Build brechen, nicht erst den Start auf dem Pi
RUN node --check app/server.js && test -s app/regeln/mailPruefung.js

COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
