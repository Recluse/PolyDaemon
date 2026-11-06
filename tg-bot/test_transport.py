import unittest
import httpx
from bridge.client import ChannelPluginClient, InstanceConfig
from bridge.transport import DialMap


class TransportTests(unittest.IsolatedAsyncioTestCase):
    def test_exact_mapping_no_fallback(self):
        dial = DialMap({"workstation:3100": 43100}, ["local-host"])
        self.assertEqual(dial.url("http://workstation:3100/status"), "http://127.0.0.1:43100/status")
        self.assertEqual(dial.url("http://local-host:3100/status"), "http://local-host:3100/status")
        for url in ["http://workstation:3101/status", "http://other:3100", "http://user@workstation:3100", "https://workstation:3100"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                dial.url(url)
        for routes in [{"workstation:3100/x": 43100}, {"workstation:3100": True}, {"workstation:3100": 22}]:
            with self.assertRaises(ValueError):
                DialMap(routes)
        self.assertEqual(DialMap().url("http://workstation:3100/status"), "http://workstation:3100/status")

    async def test_identity_and_auth_survive_sync_and_requests(self):
        instance = InstanceConfig("window", "workstation", 3100, "fixture-secret")
        client = ChannelPluginClient([instance], transport_routes={"workstation:3100":43100, "workstation:8091":48091})
        seen = []
        def respond(request):
            seen.append((str(request.url), request.headers.get("authorization")))
            return httpx.Response(200, json={"ok":True})
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        try:
            client.sync_instances([instance])
            await client.post_message("window", {"text":"fixture"})
            await client.post_topic_activity(instance, {})
            await client.post_approve_callback("window", "fixture", "once")
            await client.get_agent_version("http://workstation:8091", "fixture-secret")
            self.assertEqual([url for url, _ in seen], [
                "http://127.0.0.1:43100/message", "http://127.0.0.1:43100/topic-activity",
                "http://127.0.0.1:43100/approve-callback", "http://127.0.0.1:48091/version"])
            self.assertTrue(all(auth == "Bearer fixture-secret" for _, auth in seen))
            self.assertEqual((instance.host, instance.port), ("workstation", 3100))
        finally:
            await client.aclose()
