# SPDX-License-Identifier: MIT

FROM php:8.3-fpm

RUN apt-get update \
    && apt-get install -y --no-install-recommends libcurl4-openssl-dev libpq-dev \
    && docker-php-ext-install curl pdo_pgsql \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /var/www/html
COPY . /var/www/html
