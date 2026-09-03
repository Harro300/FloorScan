"""Kuuntelee sekä localhost (IPv6) että 127.0.0.1 (IPv4) portissa 7070."""
import http.server
import socket
import threading

PORT = 7070


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


def run(host, family):
    class Server(http.server.ThreadingHTTPServer):
        address_family = family
        allow_reuse_address = True

    httpd = Server((host, PORT), Handler)
    httpd.serve_forever()


if __name__ == "__main__":
    threading.Thread(
        target=run, args=("127.0.0.1", socket.AF_INET), daemon=True
    ).start()
    print("Pohjapiirustus-skanneri: http://localhost:7070")
    print("                        http://127.0.0.1:7070")
    run("::1", socket.AF_INET6)
