"""Explicit temporary SSH dial endpoints, separate from registry identities."""
from urllib.parse import urlsplit, urlunsplit


class DialMap:
    def __init__(self, routes=None, direct_hosts=None):
        if routes is None:
            routes = {}
        if not isinstance(routes, dict):
            raise ValueError("transport_routes must be a mapping")
        self.routes = {}
        for origin, target_port in routes.items():
            parsed = urlsplit("http://" + origin)
            if (not parsed.hostname or parsed.username or parsed.password or parsed.path
                    or parsed.query or parsed.fragment or parsed.port is None
                    or type(target_port) is not int or not 1024 <= target_port <= 65535):
                raise ValueError("invalid transport route")
            key = (parsed.hostname, parsed.port)
            if key in self.routes:
                raise ValueError("duplicate transport route")
            self.routes[key] = target_port
        if direct_hosts is None:
            direct_hosts = []
        if not isinstance(direct_hosts, list) or not all(isinstance(h, str) and h for h in direct_hosts):
            raise ValueError("transport_direct_hosts must be a list")
        self.direct_hosts = frozenset(direct_hosts)

    def url(self, url):
        if not self.routes:
            return url
        parsed = urlsplit(url)
        if parsed.scheme != "http" or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("unsupported transport URL")
        port = self.routes.get((parsed.hostname, parsed.port or 80))
        if port is not None:
            return urlunsplit(("http", f"127.0.0.1:{port}", parsed.path, parsed.query, ""))
        if parsed.hostname in self.direct_hosts:
            return url
        raise ValueError("no configured transport route for callback")
