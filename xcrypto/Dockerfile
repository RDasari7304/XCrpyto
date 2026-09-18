# One image runs both the web service and the mention worker; the command
# differs per service.
FROM node:20-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY web/package*.json ./web/
RUN cd web && npm install

COPY . .
RUN cd web && npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run unprivileged.
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/web/dist ./web/dist

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
