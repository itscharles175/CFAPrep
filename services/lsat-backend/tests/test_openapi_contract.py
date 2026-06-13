from __future__ import annotations


def test_launch_readiness_routes_have_openapi_response_schemas(client):
    spec = client.get("/openapi.json").json()
    assert "ErrorEnvelope" in spec["components"]["schemas"]
    assert "LegacySuccessResponse" in spec["components"]["schemas"]
    expected = [
        ("/api/health", "get"),
        ("/api/ready", "get"),
        ("/api/backup/integrity", "get"),
        ("/api/observability/status", "get"),
    ]
    for path, method in expected:
        op = spec["paths"][path][method]
        schema = (
            op["responses"]["200"]["content"]["application/json"]
            .get("schema")
        )
        assert schema, f"{method.upper()} {path} lacks a 200 response schema"
        assert "422" in op["responses"]
        assert (
            op["responses"]["422"]["content"]["application/json"]["schema"]["$ref"]
            == "#/components/schemas/ErrorEnvelope"
        )


def test_all_api_routes_have_success_and_error_schemas(client):
    spec = client.get("/openapi.json").json()
    missing_success = []
    missing_error = []
    for path, methods in spec["paths"].items():
        if not path.startswith("/api/"):
            continue
        for method, op in methods.items():
            responses = op.get("responses", {})
            if method.lower() != "delete" and "200" in responses:
                schema = (
                    responses["200"]["content"]["application/json"].get("schema")
                )
                if not schema:
                    missing_success.append((method.upper(), path))
            for code in ("400", "404", "422", "500"):
                schema = (
                    responses.get(code, {})
                    .get("content", {})
                    .get("application/json", {})
                    .get("schema")
                )
                if not schema:
                    missing_error.append((method.upper(), path, code))
    assert missing_success == []
    assert missing_error == []
