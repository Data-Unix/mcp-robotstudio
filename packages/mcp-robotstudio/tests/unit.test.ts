import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeDigestAuthorization,
  md5,
  parseAuthenticateHeader,
  parseCtrlStateXml,
  parseEventLogXml,
  parseExecutionXml,
  parseJointTargetXml,
  parseMastershipXml,
  parseModulesXml,
  parseOpModeXml,
  parseRobTargetXml,
  parseRwsErrorBody,
  parseSignalsListXml,
  parseSingleSignalXml,
  parseSymbolXml,
  parseSystemXml,
  parseTasksXml,
  RwsError,
} from "../src/rws/index.js";

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../referencias/rws-rw6-fixtures",
);

interface FixtureJson {
  request: string;
  status: number;
  headers: Record<string, string>;
  note: string;
  body: string;
}

function loadFixture(name: string): FixtureJson {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as FixtureJson;
}

describe("MD5 (RFC 1321)", () => {
  it("matches Node crypto MD5 across ASCII, empty, UTF-8, and multi-block inputs", () => {
    const vectors = [
      "",
      "a",
      "abc",
      "message digest",
      "abcdefghijklmnopqrstuvwxyz",
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "Default User:validusers@robapi.abb:robotics",
      "Robótica ABB € ñ áéíóú — prueba UTF-8 larga ".repeat(12),
    ];

    for (const input of vectors) {
      const expected = crypto.createHash("md5").update(input, "utf8").digest("hex");
      expect(md5(input)).toBe(expected);
    }
  });
});

describe("HTTP Digest MD5 (RFC 7616 / RFC 2617)", () => {
  it("matches RFC 7616 Section 3.9.1 MD5 qop=auth test vector", () => {
    const res = computeDigestAuthorization({
      username: "Mufasa",
      password: "Circle of Life",
      method: "GET",
      uri: "/dir/index.html",
      challenge: {
        realm: "http-auth@example.org",
        nonce: "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
        opaque: "FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS",
        qop: "auth",
        algorithm: "MD5",
        stale: false,
      },
      nc: 1,
      cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
    });

    expect(res.response).toBe("8ca523f5e9506fed4657c9700eebdbec");
    expect(res.ncHex).toBe("00000001");
    expect(res.header).toContain("algorithm=MD5");
    expect(res.header).toContain("qop=auth");
  });

  it("matches RFC 2617 Section 3.5 test vector", () => {
    const res = computeDigestAuthorization({
      username: "Mufasa",
      password: "Circle Of Life",
      method: "GET",
      uri: "/dir/index.html",
      challenge: {
        realm: "testrealm@host.com",
        nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
        opaque: "5ccc069c403ebaf9f0171e9517f40e41",
        qop: "auth",
        algorithm: "MD5",
        stale: false,
      },
      nc: 1,
      cnonce: "0a4f113b",
    });

    expect(res.response).toBe("6629fae49393a05397450978507c4ef1");
  });

  it("parses captured RW6 401 Digest challenge and strictly rejects Basic", () => {
    const f00 = loadFixture("00-challenge-sin-credenciales.json");
    const parsed = parseAuthenticateHeader(f00.headers["www-authenticate"]!);
    expect(parsed.realm).toBe("validusers@robapi.abb");
    expect(parsed.qop).toBe("auth");
    expect(parsed.algorithm).toBe("MD5");
    expect(parsed.stale).toBe(false);

    expect(() => parseAuthenticateHeader('Basic realm="validusers@robapi.abb"')).toThrowError(RwsError);
    try {
      parseAuthenticateHeader('Basic realm="validusers@robapi.abb"');
    } catch (err) {
      expect(err).toBeInstanceOf(RwsError);
      expect((err as RwsError).rwsCode).toBe("BASIC_AUTH_REJECTED");
    }

    expect(() => parseAuthenticateHeader("")).toThrowError(RwsError);
  });
});

describe("RobotWare 6.16 real XML fixtures (all 16 captures)", () => {
  it("contains and validates all 16 JSON fixtures without omitting any", () => {
    const jsonFiles = fs
      .readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(jsonFiles).toHaveLength(16);

    const f00 = loadFixture("00-challenge-sin-credenciales.json");
    expect(f00.status).toBe(401);
    expect(f00.body).toBe("Access Denied. Login required");

    const f01 = parseSystemXml(loadFixture("01-system.json").body);
    expect(f01.name).toBe("IRB120_3_58");
    expect(f01.rwversion).toBe("6.16.3007");
    expect(f01.rwversionname).toBe("6.16.03.00");
    expect(f01.options).toHaveLength(9);
    expect(f01.options[0]).toBe("RobotWare Base");

    expect(parseCtrlStateXml(loadFixture("02-panel-ctrlstate.json").body).ctrlstate).toBe("guardstop");
    expect(parseOpModeXml(loadFixture("03-panel-opmode.json").body).opmode).toBe("MANR");
    expect(parseExecutionXml(loadFixture("04-rapid-execution.json").body)).toEqual({
      ctrlexecstate: "stopped",
      cycle: "forever",
    });

    const f05 = parseTasksXml(loadFixture("05-rapid-tasks.json").body);
    expect(f05.tasks).toHaveLength(1);
    expect(f05.tasks[0]).toMatchObject({
      name: "T_ROB1",
      type: "norm",
      taskstate: "link",
      excstate: "read",
      active: "On",
      motiontask: "TRUE",
    });

    const f06 = parseModulesXml(loadFixture("06-rapid-modules-rw6.json").body);
    expect(f06.modules).toEqual(["user", "BASE"]);
    expect(f06.items).toEqual([
      { name: "user", type: "SysMod" },
      { name: "BASE", type: "SysMod" },
    ]);

    const f07 = loadFixture("07-rapid-modules-ruta-rw7-404.json");
    expect(f07.status).toBe(404);
    const e07 = parseRwsErrorBody(f07.body);
    expect(e07.code).toBe("-1073414146");
    expect(e07.msg).toContain("Resource not found");

    const f08 = parseSymbolXml(loadFixture("08-symbol-tool0.json").body);
    expect(f08.value).toBe("[TRUE,[[0,0,0],[1,0,0,0]],[0.001,[0,0,0.001],[1,0,0,0],0,0,0]]");

    const f09 = loadFixture("09-symbol-no-existe.json");
    expect(f09.status).toBe(400);
    const e09 = parseRwsErrorBody(f09.body);
    expect(e09.code).toBe("-1073414146");
    expect(e09.msg).toContain("Symbol not found");

    const f10 = parseSignalsListXml(loadFixture("10-signals-pagina.json").body);
    expect(f10.signals.map((s) => s.name)).toEqual([
      "DRV1TESTE2",
      "DRV1BRAKE",
      "DRV1CHAIN2",
      "DRV1CHAIN1",
      "DRV1BRAKEOK",
    ]);
    expect(f10.hasNext).toBe(true);

    const f11 = parseSingleSignalXml(loadFixture("11-signal-por-nombre.json").body);
    expect(f11).toMatchObject({
      name: "DRV1TESTE2",
      type: "DO",
      category: "safety",
      value: "0",
      state: "not simulated",
    });

    const f12 = parseEventLogXml(loadFixture("12-elog-dominio0.json").body);
    expect(f12.events).toHaveLength(9);
    expect(f12.events[0]?.code).toBe("10129");
    expect(f12.events[0]?.title).toBe("Program stopped");

    const f13 = parseJointTargetXml(loadFixture("13-jointtarget.json").body);
    expect(f13.jointsDeg).toEqual([0, 0, 0, 0, 0, 0]);

    const f14 = parseRobTargetXml(loadFixture("14-robtarget-tool0-wobj0.json").body);
    expect(f14.x).toBe(374);
    expect(f14.y).toBe(0);
    expect(f14.z).toBe(630);
    expect(f14.q1).toBeCloseTo(0.7071068, 5);
    expect(f14.q3).toBeCloseTo(0.7071068, 5);

    const f15 = parseMastershipXml(loadFixture("15-mastership.json").body);
    expect(f15.domains).toEqual(["cfg", "motion", "rapid"]);
  });
});
