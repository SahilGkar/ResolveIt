ARG NODE_VERSION=20.11.0

FROM --platform=linux/amd64 node:${NODE_VERSION}-alpine AS base
WORKDIR /app

FROM registry.example.com:5000/team/app:1.2.3 AS release
COPY --from=base /app /app

FROM postgres:15.4@sha256:deadbeef1234 AS db
