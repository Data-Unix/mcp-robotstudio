# Certificado TLS de prueba (solo tests)

`test-cert.pem` / `test-key.pem`: par autofirmado para `127.0.0.1` / `localhost`, generado con
`openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=127.0.0.1/O=mcp-robotstudio test only"`.

Lo usa `FakeRwsServer({ dialect: "rws2" })` para simular el HTTPS de un OmniCore (RWS 2.0) con certificado
autofirmado de fábrica. La clave es pública a propósito: **no protege nada** y no debe usarse fuera de los tests.
