FROM node:18.15 as build-step
RUN mkdir -p /app
WORKDIR /app
COPY ./app/package.json /app
RUN npm install -g @angular/cli
RUN npm install --legacy-peer-deps
COPY ./app/ /app
RUN node ./node_modules/@angular/cli/bin/ng build --configuration production
FROM nginx:latest
COPY --from=build-step /app/dist /usr/share/nginx/html
