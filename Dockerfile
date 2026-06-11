# Static site — no build step. Just serve the files with busybox httpd.
# The lipanski image serves the working dir (/home/static) on port 3000.
FROM lipanski/docker-static-website:latest
COPY . .
EXPOSE 3000
