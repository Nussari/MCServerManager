#!/bin/sh

# Seed/update templates/common from the defaults baked into the image
cp -r /app/defaults/common /app/templates/

exec node src/index.js
