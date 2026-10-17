FROM node:26.11.1-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs version.json ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
