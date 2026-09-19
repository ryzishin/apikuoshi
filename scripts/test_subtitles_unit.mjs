import { detectSubtitleFormat, srtToVtt, vttToSrt, convertSubtitle } from "../src/core/subtitles.js";

const srt = `1
00:00:01,000 --> 00:00:04,500
Hello world

2
00:01:02,250 --> 00:01:05,750
Line one
Line two
`;
const vtt = `WEBVTT

00:20.240 --> 00:29.210
<b>Beyond Journey's End</b>

intro-01
01:29.980 --> 01:39.740 position:50% align:center
Second cue text
`;

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, extra); }
};

check("detect srt", detectSubtitleFormat(srt) === "srt", detectSubtitleFormat(srt));
check("detect vtt", detectSubtitleFormat(vtt) === "vtt", detectSubtitleFormat(vtt));
check("detect ass", detectSubtitleFormat("[Script Info]\nTitle: x") === "ass");

const v1 = srtToVtt(srt);
check("srt->vtt header", v1.startsWith("WEBVTT"));
check("srt->vtt dot", v1.includes("00:00:01.000 --> 00:00:04.500"), v1.split("\n")[2]);
check("srt->vtt keeps text", v1.includes("Hello world") && v1.includes("Line one\nLine two"));
check("srt->vtt drops counter", !v1.includes("\n1\n"));

const s1 = vttToSrt(vtt);
check("vtt->srt counter", s1.startsWith("1\n00:20,240".replace("00:20", "00:00:20")), s1.split("\n").slice(0,2).join("|"));
check("vtt->srt comma", s1.includes("00:00:20,240 --> 00:00:29,210"), s1.split("\n")[1]);
check("vtt->srt drops settings", !s1.includes("position:50%"));
check("vtt->srt drops cue id", !s1.includes("intro-01"));
check("vtt->srt keeps text", s1.includes("Second cue text"));
check("vtt->srt two cues", s1.trim().split("\n\n").length === 2);

const c1 = convertSubtitle(srt, "vtt");
check("convert srt->vtt", c1.format === "vtt" && c1.converted);
const c2 = convertSubtitle(vtt, "srt");
check("convert vtt->srt", c2.format === "srt" && c2.converted);
const c3 = convertSubtitle(vtt, "vtt");
check("convert vtt->vtt noop", c3.format === "vtt" && !c3.converted);
const c4 = convertSubtitle(srt, "srt");
check("convert srt->srt noop", c4.format === "srt" && !c4.converted);
const c5 = convertSubtitle("[Script Info]\nDialogue: x", "srt");
check("ass untouched", c5.format === "ass" && !c5.converted);
// roundtrip
const rt = vttToSrt(srtToVtt(vtt));
check("roundtrip vtt->srt->vtt->srt keeps dialogue", rt.includes("Second cue text") && rt.includes("00:01:29,980"), rt);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
