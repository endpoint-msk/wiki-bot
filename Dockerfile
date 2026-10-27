FROM node:22-alpine
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci --omit=dev

COPY src /app/src

# node directly, not npm: with npm as PID 1 SIGTERM never reaches the process and the state is not saved.
CMD [ "node", "--import", "tsx", "src/index.ts" ]
