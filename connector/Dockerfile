FROM node:24.13.1-bookworm-slim@sha256:a81a03dd965b4052269a57fac857004022b522a4bf06e7a739e25e18bce45af2
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node *.mjs ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node viewer ./viewer
USER node
ENTRYPOINT ["node"]
CMD ["server.mjs", "as"]
