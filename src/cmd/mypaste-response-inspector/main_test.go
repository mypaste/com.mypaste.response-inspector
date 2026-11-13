package main

import (
	"bufio"
	"encoding/json"
	"io"
	"testing"
)

func pipeRun(t *testing.T, request string, answer func(call hostCall) string) (response, []hostCall) {
	t.Helper()
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- run(inputReader, outputWriter) }()
	if _, err := inputWriter.Write([]byte(request + "\n")); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(outputReader)
	calls := make([]hostCall, 0, 1)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatalf("read plugin line: %v", err)
		}
		var call hostCall
		if err := json.Unmarshal(line, &call); err != nil {
			t.Fatalf("plugin wrote a non-JSON line %q: %v", line, err)
		}
		if call.Type != "hostCall" {
			var reply response
			if err := json.Unmarshal(line, &reply); err != nil {
				t.Fatal(err)
			}
			_ = inputWriter.Close()
			_ = outputWriter.Close()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			return reply, calls
		}
		calls = append(calls, call)
		if _, err := inputWriter.Write([]byte(answer(call) + "\n")); err != nil {
			t.Fatal(err)
		}
	}
}

func invocationLine(command, text string) string {
	encoded, err := json.Marshal(map[string]any{
		"protocolVersion": 2,
		"id":              "req-1",
		"method":          "invoke",
		"commandId":       command,
		"input":           map[string]string{"type": "text/plain", "text": text},
	})
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func TestRunInspectsThroughTheHost(t *testing.T) {
	report := `{"status":204,"statusText":"204 No Content","finalUrl":"https://example.com/","headers":[{"name":"Content-Type","value":"text/plain"}]}`
	reply, calls := pipeRun(t, invocationLine("inspect", "example.com"), func(call hostCall) string {
		if call.Service != "network.inspect" || call.Method != "inspect" {
			t.Fatalf("host call = %#v", call)
		}
		var params map[string]string
		raw, err := json.Marshal(call.Params)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, &params); err != nil {
			t.Fatal(err)
		}
		if params["url"] != "https://example.com" {
			t.Fatalf("url = %q", params["url"])
		}
		return `{"type":"hostCallResult","id":"` + call.ID + `","ok":true,"result":` + report + `}`
	})
	if len(calls) != 1 {
		t.Fatalf("host calls = %d", len(calls))
	}
	if !reply.OK || reply.Result == nil {
		t.Fatalf("reply = %#v", reply)
	}
	if reply.Result.Output != report {
		t.Fatalf("output = %q", reply.Result.Output)
	}
	if reply.ID != "req-1" {
		t.Fatalf("reply id = %q", reply.ID)
	}
}

func TestRunReportsTheHostRefusal(t *testing.T) {
	reply, _ := pipeRun(t, invocationLine("inspect", "http://example.com/a"), func(call hostCall) string {
		return `{"type":"hostCallResult","id":"` + call.ID + `","ok":false,"error":"目标地址不是公网地址，不能检查"}`
	})
	if reply.OK || reply.Error == nil {
		t.Fatalf("reply = %#v", reply)
	}
	if reply.Error.Message != "目标地址不是公网地址，不能检查" {
		t.Fatalf("message = %q", reply.Error.Message)
	}
}

func TestRunRefusesAnotherCommand(t *testing.T) {
	reply, calls := pipeRun(t, invocationLine("format", "example.com"), func(hostCall) string {
		t.Fatal("an unknown command must not reach the host")
		return ""
	})
	if len(calls) != 0 || reply.OK || reply.Error == nil {
		t.Fatalf("reply = %#v, calls = %#v", reply, calls)
	}
}

func TestNormalizeAddress(t *testing.T) {
	for raw, want := range map[string]string{
		"  example.com  ":     "https://example.com",
		"example.com/a?b=c":   "https://example.com/a?b=c",
		"http://example.com":  "https://example.com",
		"HTTPS://example.com": "HTTPS://example.com",
		"ftp://example.com":   "ftp://example.com",
		"":                    "",
	} {
		if got := normalizeAddress(raw); got != want {
			t.Fatalf("normalizeAddress(%q) = %q, want %q", raw, got, want)
		}
	}
}
