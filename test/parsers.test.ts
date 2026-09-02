import test from "node:test";
import assert from "node:assert/strict";
import { cpuUsage, parseCpuTimes, parseOsRelease, parseSmartHealth, parseSmartTemperature, severity } from "../src/parsers.js";

test("parses quoted Debian name",()=>assert.equal(parseOsRelease('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n'),"Debian GNU/Linux 13 (trixie)"));
test("calculates aggregate CPU usage",()=>assert.equal(cpuUsage(parseCpuTimes("cpu  10 0 10 80 0 0 0"),parseCpuTimes("cpu  20 0 20 160 0 0 0")),20));
test("parses SMART passed health",()=>assert.equal(parseSmartHealth("SMART overall-health self-assessment test result: PASSED"),"PASSED"));
test("treats reported SMART failure as failed",()=>assert.equal(parseSmartHealth("SMART Health Status: BAD"),"FAILED"));
test("parses ATA Temperature_Celsius raw value",()=>assert.equal(parseSmartTemperature("194 Temperature_Celsius     0x0022   100 100 000 Old_age Always - 37"),37));
test("parses ATA Temperature_Internal raw value",()=>assert.equal(parseSmartTemperature("190 Temperature_Internal    0x0022   067 050 000 Old_age Always - 33"),33));
test("parses ATA Airflow_Temperature_Cel raw value",()=>assert.equal(parseSmartTemperature("190 Airflow_Temperature_Cel 0x0022 069 045 000 Old_age Always - 31 (Min/Max 22/38)"),31));
test("returns null when SMART temperature is unavailable",()=>assert.equal(parseSmartTemperature("SMART overall-health self-assessment test result: PASSED"),null));
test("assigns threshold severity",()=>{assert.equal(severity(74),"online");assert.equal(severity(75),"warning");assert.equal(severity(90),"error");assert.equal(severity(null),"unknown")});
