// Command mypaste-response-inspector is the response-header and certificate
// viewer's own runtime.
//
// A UI package may declare a runtime and placement-less commands of its own
// (PLUGINS.md §5.2): only this package's page can reach `inspect`, and it never
// appears in the command palette. The page cannot fetch a foreign URL itself —
// a cross-origin fetch exposes neither the full header list nor the TLS
// connection — so this process asks the host's `network.inspect` service and
// hands the report back as one JSON document.
//
// The host owns the destination policy: it dials only public addresses, reads
// no body, and records only host and status. This process never opens a socket.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

const (
	maxRequestBytes = 1 << 20
	commandID       = "inspect"
	service         = "network.inspect"
)

type invocation struct {
	ID        string `json:"id"`
	CommandID string `json:"commandId"`
	Input     *struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"input"`
}

type hostCall struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Service string `json:"service"`
	Method  string `json:"method,omitempty"`
	Params  any    `json:"params,omitempty"`
}

type hostCallResult struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type response struct {
	ID     string         `json:"id"`
	OK     bool           `json:"ok"`
	Result *commandResult `json:"result,omitempty"`
	Error  *commandError  `json:"error,omitempty"`
}

type commandResult struct {
	Output string `json:"output,omitempty"`
}

type commandError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		// Without a request id there is no line the host could match; the
		// process exits and the host reports the invocation as failed.
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run reads one invocation, performs one host call and writes one response.
func run(input io.Reader, output io.Writer) error {
	reader := bufio.NewReaderSize(input, 64<<10)
	line, err := reader.ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return errors.New("读取调用请求失败")
	}
	if len(line) > maxRequestBytes {
		return errors.New("调用请求超过大小上限")
	}
	var call invocation
	if err := json.Unmarshal(line, &call); err != nil {
		return errors.New("调用请求无法读取")
	}
	reply := response{ID: call.ID}
	if call.CommandID != commandID {
		reply.Error = &commandError{Code: "unknown-command", Message: "未知命令"}
	} else if report, inspectErr := inspect(reader, output, addressOf(call)); inspectErr != nil {
		reply.Error = &commandError{Code: "inspect-failed", Message: inspectErr.Error()}
	} else {
		reply.OK = true
		reply.Result = &commandResult{Output: report}
	}
	encoded, err := json.Marshal(reply)
	if err != nil {
		return errors.New("无法编码调用结果")
	}
	if _, err := output.Write(append(encoded, '\n')); err != nil {
		return errors.New("无法写入调用结果")
	}
	return nil
}

// addressOf reads the invocation's input text and normalizes it.
func addressOf(call invocation) string {
	if call.Input == nil {
		return ""
	}
	return normalizeAddress(call.Input.Text)
}

// normalizeAddress turns the text a person pasted into an HTTPS URL. A bare
// host gets https://; an explicit http:// is upgraded, because the host's
// inspector — like every network service — speaks HTTPS only.
func normalizeAddress(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)
	switch {
	case strings.HasPrefix(lower, "https://"):
		return trimmed
	case strings.HasPrefix(lower, "http://"):
		return "https://" + trimmed[len("http://"):]
	case strings.Contains(trimmed, "://"):
		return trimmed
	default:
		return "https://" + trimmed
	}
}

// inspect asks the host for one report and returns it as compact JSON text.
func inspect(reader *bufio.Reader, output io.Writer, address string) (string, error) {
	if address == "" {
		return "", errors.New("请填写要检查的地址")
	}
	client := &hostClient{reader: reader, output: output}
	raw, err := client.call(service, "inspect", map[string]string{"url": address})
	if err != nil {
		return "", err
	}
	if !json.Valid(raw) {
		return "", errors.New("检查结果无法读取")
	}
	return string(raw), nil
}

type hostClient struct {
	reader *bufio.Reader
	output io.Writer
	calls  int
}

// call writes one hostCall line and waits for its matching hostCallResult.
// The host answers every call; a different id is skipped, exactly as the line
// protocol defines.
func (c *hostClient) call(serviceName, method string, params any) (json.RawMessage, error) {
	if c.calls >= 4 {
		return nil, errors.New("宿主调用次数过多")
	}
	c.calls++
	call := hostCall{
		Type:    "hostCall",
		ID:      "r" + strconv.Itoa(c.calls),
		Service: serviceName,
		Method:  method,
		Params:  params,
	}
	encoded, err := json.Marshal(call)
	if err != nil {
		return nil, errors.New("无法编码宿主调用")
	}
	if _, err := c.output.Write(append(encoded, '\n')); err != nil {
		return nil, errors.New("无法写入宿主调用")
	}
	for {
		line, err := c.reader.ReadBytes('\n')
		if err != nil && len(line) == 0 {
			return nil, errors.New("宿主调用没有响应")
		}
		var result hostCallResult
		if err := json.Unmarshal(line, &result); err != nil {
			return nil, errors.New("宿主调用响应无法读取")
		}
		if result.Type != "hostCallResult" {
			return nil, errors.New("宿主返回了意外的消息")
		}
		if result.ID != call.ID {
			continue
		}
		if !result.OK {
			if result.Error == "" {
				result.Error = "宿主调用失败"
			}
			return nil, errors.New(result.Error)
		}
		return result.Result, nil
	}
}
