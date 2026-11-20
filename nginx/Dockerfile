FROM nginx:alpine

COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf /etc/nginx/conf.d/default.conf
COPY stream.conf /etc/nginx/stream.d/stream.conf
EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
