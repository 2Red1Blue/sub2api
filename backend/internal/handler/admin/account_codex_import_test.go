package admin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/service"
)

func TestImportCodexSessionsCreatesNewAccountsInBatch(t *testing.T) {
	adminSvc := newStubAdminService()
	adminSvc.accounts = nil
	handler := &AccountHandler{adminService: adminSvc}

	token1 := buildCodexImportTestJWT(t, time.Now().Add(time.Hour), map[string]any{
		"email": "batch-a@example.com",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "acct-batch-a",
			"chatgpt_user_id":    "user-batch-a",
		},
	})
	token2 := buildCodexImportTestJWT(t, time.Now().Add(time.Hour), map[string]any{
		"email": "batch-b@example.com",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "acct-batch-b",
			"chatgpt_user_id":    "user-batch-b",
		},
	})
	req := CodexSessionImportRequest{
		Contents: []string{
			fmt.Sprintf(`{"type":"codex","email":"batch-a@example.com","access_token":%q,"refresh_token":"refresh-a"}`, token1),
			fmt.Sprintf(`{"type":"codex","email":"batch-b@example.com","access_token":%q,"refresh_token":"refresh-b"}`, token2),
		},
		GroupIDs: []int64{3},
	}

	entries, err := parseCodexSessionImportEntries(req)
	if err != nil {
		t.Fatalf("parseCodexSessionImportEntries error = %v", err)
	}
	result, err := handler.importCodexSessions(context.Background(), req, entries)
	if err != nil {
		t.Fatalf("importCodexSessions error = %v", err)
	}

	if result.Created != 2 || result.Failed != 0 {
		t.Fatalf("created=%d failed=%d, want created=2 failed=0; result=%#v", result.Created, result.Failed, result)
	}
	if adminSvc.createAccountCalls != 0 {
		t.Fatalf("CreateAccount calls = %d, want 0", adminSvc.createAccountCalls)
	}
	if adminSvc.createAccountsCalls != 1 {
		t.Fatalf("CreateAccounts calls = %d, want 1", adminSvc.createAccountsCalls)
	}
	if len(adminSvc.createdAccounts) != 2 {
		t.Fatalf("createdAccounts len = %d, want 2", len(adminSvc.createdAccounts))
	}
	for i, input := range adminSvc.createdAccounts {
		if input.Platform != service.PlatformOpenAI || input.Type != service.AccountTypeOAuth {
			t.Fatalf("input[%d] platform/type = %s/%s", i, input.Platform, input.Type)
		}
		if len(input.GroupIDs) != 1 || input.GroupIDs[0] != 3 {
			t.Fatalf("input[%d] groupIDs = %#v, want [3]", i, input.GroupIDs)
		}
	}
	for _, item := range result.Items {
		if item.Action != "created" || item.AccountID == 0 {
			t.Fatalf("result item = %#v, want created with account id", item)
		}
	}
}

func TestParseCodexSessionImportEntriesSupportsRawTokenJSONAndArray(t *testing.T) {
	token1 := "raw-access-token-1"
	token2 := buildCodexImportTestJWT(t, time.Now().Add(time.Hour), map[string]any{
		"email": "json@example.com",
	})
	token3 := "raw-access-token-3"

	req := CodexSessionImportRequest{
		Content: fmt.Sprintf("%s\n{\"accessToken\":%q}\n[%q]", token1, token2, token3),
	}

	entries, err := parseCodexSessionImportEntries(req)
	if err != nil {
		t.Fatalf("parseCodexSessionImportEntries error = %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("len(entries) = %d, want 3", len(entries))
	}

	first, err := normalizeCodexImportEntry(entries[0])
	if err != nil {
		t.Fatalf("normalize raw token error = %v", err)
	}
	if first.Credentials["access_token"] != token1 {
		t.Fatalf("raw token access_token = %v, want %s", first.Credentials["access_token"], token1)
	}

	second, err := normalizeCodexImportEntry(entries[1])
	if err != nil {
		t.Fatalf("normalize json token error = %v", err)
	}
	if second.Email != "json@example.com" {
		t.Fatalf("email = %q, want json@example.com", second.Email)
	}

	third, err := normalizeCodexImportEntry(entries[2])
	if err != nil {
		t.Fatalf("normalize array token error = %v", err)
	}
	if third.Credentials["access_token"] != token3 {
		t.Fatalf("array token access_token = %v, want %s", third.Credentials["access_token"], token3)
	}
}

func TestParseCodexSessionImportEntriesFallsBackToLineModeForMixedJSONAndToken(t *testing.T) {
	req := CodexSessionImportRequest{
		Content: "{\"accessToken\":\"json-line-token\"}\nraw-line-token",
	}

	entries, err := parseCodexSessionImportEntries(req)
	if err != nil {
		t.Fatalf("parseCodexSessionImportEntries error = %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("len(entries) = %d, want 2", len(entries))
	}

	first, err := normalizeCodexImportEntry(entries[0])
	if err != nil {
		t.Fatalf("normalize json line error = %v", err)
	}
	if first.Credentials["access_token"] != "json-line-token" {
		t.Fatalf("json line access_token = %v, want json-line-token", first.Credentials["access_token"])
	}

	second, err := normalizeCodexImportEntry(entries[1])
	if err != nil {
		t.Fatalf("normalize raw line error = %v", err)
	}
	if second.Credentials["access_token"] != "raw-line-token" {
		t.Fatalf("raw line access_token = %v, want raw-line-token", second.Credentials["access_token"])
	}
}

func TestParseCodexSessionImportEntriesSupportsNamedItems(t *testing.T) {
	req := CodexSessionImportRequest{
		Items: []CodexSessionImportSource{
			{Name: "alice", Content: `{"accessToken":"token-a"}`},
			{Name: "bob", Content: `{"accessToken":"token-b"}`},
		},
	}

	entries, err := parseCodexSessionImportEntries(req)
	if err != nil {
		t.Fatalf("parseCodexSessionImportEntries error = %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("len(entries) = %d, want 2", len(entries))
	}
	if entries[0].Name != "alice" || entries[1].Name != "bob" {
		t.Fatalf("entry names = %q, %q; want alice, bob", entries[0].Name, entries[1].Name)
	}
}

func TestParseCodexSessionImportEntriesExpandsAccountExportPackage(t *testing.T) {
	token := buildCodexImportTestJWT(t, time.Now().Add(time.Hour), map[string]any{
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "acct-from-claim",
			"chatgpt_user_id":    "user-from-claim",
			"chatgpt_plan_type":  "team",
		},
	})
	req := CodexSessionImportRequest{
		Content: `{
			"exported_at": "2026-06-08T18:27:56Z",
			"proxies": [],
			"accounts": [
				{
					"name": "exported@example.com",
					"platform": "openai",
					"type": "oauth",
					"credentials": {
						"access_token": "` + token + `",
						"refresh_token": "refresh-from-export",
						"chatgpt_account_id": "acct-from-export",
						"chatgpt_user_id": "user-from-export",
						"expires_at": 1781782868
					},
					"extra": {
						"email": "extra@example.com"
					}
				}
			]
		}`,
	}

	entries, err := parseCodexSessionImportEntries(req)
	if err != nil {
		t.Fatalf("parseCodexSessionImportEntries error = %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1", len(entries))
	}

	item, err := normalizeCodexImportEntry(entries[0])
	if err != nil {
		t.Fatalf("normalize export account error = %v", err)
	}
	if item.Credentials["access_token"] != token {
		t.Fatalf("access_token not read from credentials")
	}
	if item.Credentials["refresh_token"] != "refresh-from-export" {
		t.Fatalf("refresh_token = %v, want refresh-from-export", item.Credentials["refresh_token"])
	}
	if item.Credentials["chatgpt_account_id"] != "acct-from-export" {
		t.Fatalf("chatgpt_account_id = %v, want acct-from-export", item.Credentials["chatgpt_account_id"])
	}
	if item.Credentials["chatgpt_user_id"] != "user-from-export" {
		t.Fatalf("chatgpt_user_id = %v, want user-from-export", item.Credentials["chatgpt_user_id"])
	}
	if item.Credentials["email"] != "extra@example.com" {
		t.Fatalf("email = %v, want extra@example.com", item.Credentials["email"])
	}
}

func TestNormalizeCodexSimpleCredentialJSON(t *testing.T) {
	token := buildCodexImportTestJWT(t, time.Now().Add(time.Hour), map[string]any{
		"email": "simple@example.com",
	})
	raw := map[string]any{
		"type":          "codex",
		"email":         "simple@example.com",
		"token_source":  "ChatGPT_team",
		"access_token":  token,
		"refresh_token": "refresh-from-simple",
		"saved_at":      "2026-06-08T13:21:49Z",
	}

	item, err := normalizeCodexImportEntry(codexImportEntry{Index: 1, Value: raw})
	if err != nil {
		t.Fatalf("normalize simple account error = %v", err)
	}
	if item.Credentials["access_token"] != token {
		t.Fatalf("access_token not read from top level")
	}
	if item.Credentials["refresh_token"] != "refresh-from-simple" {
		t.Fatalf("refresh_token = %v, want refresh-from-simple", item.Credentials["refresh_token"])
	}
	if item.Credentials["email"] != "simple@example.com" {
		t.Fatalf("email = %v, want simple@example.com", item.Credentials["email"])
	}
}

func TestBuildCodexCreateAccountNameUsesFileNameWhenPrefixEmpty(t *testing.T) {
	item := &codexImportAccount{Name: "json-name"}

	got := buildCodexCreateAccountName("", "auth-file-name", item, 1, 2)
	if got != "auth-file-name" {
		t.Fatalf("name = %q, want auth-file-name", got)
	}

	got = buildCodexCreateAccountName("prefix", "auth-file-name", item, 2, 3)
	if got != "prefix #2" {
		t.Fatalf("name = %q, want prefix #2", got)
	}
}

func TestCodexIdentityKeysDoNotDeduplicateSharedAccountIDWhenUserDiffers(t *testing.T) {
	first := buildCodexIdentityKeys("shared-account", "user-a", "a@example.com", "access-a")
	second := buildCodexIdentityKeys("shared-account", "user-b", "b@example.com", "access-b")

	seen := map[string]int{}
	markCodexIdentitySeen(seen, first, 1)
	if duplicateIndex, ok := firstSeenCodexIdentity(seen, second); ok {
		t.Fatalf("second identity matched duplicate index %d, want no duplicate", duplicateIndex)
	}

	accountOnly := buildCodexIdentityKeys("shared-account", "", "", "")
	if len(accountOnly) != 1 || accountOnly[0] != "account:shared-account" {
		t.Fatalf("account-only keys = %#v, want account fallback", accountOnly)
	}
}

func TestNormalizeCodexNamedFileEntryUsesAccessTokenIdentityOnly(t *testing.T) {
	first, err := normalizeCodexImportEntry(codexImportEntry{
		Index: 1,
		Name:  "file-a",
		Value: map[string]any{
			"accessToken": "access-a",
			"account_id":  "shared-account",
			"user_id":     "shared-user",
			"email":       "same@example.com",
		},
	})
	if err != nil {
		t.Fatalf("normalize first entry error = %v", err)
	}
	second, err := normalizeCodexImportEntry(codexImportEntry{
		Index: 2,
		Name:  "file-b",
		Value: map[string]any{
			"accessToken": "access-b",
			"account_id":  "shared-account",
			"user_id":     "shared-user",
			"email":       "same@example.com",
		},
	})
	if err != nil {
		t.Fatalf("normalize second entry error = %v", err)
	}

	seen := map[string]int{}
	markCodexIdentitySeen(seen, first.IdentityKeys, 1)
	if duplicateIndex, ok := firstSeenCodexIdentity(seen, second.IdentityKeys); ok {
		t.Fatalf("second file identity matched duplicate index %d, want no duplicate", duplicateIndex)
	}
}

func TestNormalizeCodexSessionJSONExtractsCredentialsAndIgnoresSessionToken(t *testing.T) {
	accessToken := buildCodexImportTestJWT(t, time.Now().Add(time.Hour), map[string]any{
		"email": "claim@example.com",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "acct-from-claim",
			"chatgpt_user_id":    "user-from-claim",
			"chatgpt_plan_type":  "plus",
			"poid":               "org-from-claim",
		},
	})
	raw := map[string]any{
		"user": map[string]any{
			"id":    "user-from-json",
			"name":  "Sup OO",
			"email": "json@example.com",
			"image": "https://example.com/avatar.png",
		},
		"account": map[string]any{
			"id":       "acct-from-json",
			"planType": "free",
		},
		"accessToken":  accessToken,
		"sessionToken": "secret-session-token",
		"expires":      "2026-08-05T13:40:42.836Z",
	}

	item, err := normalizeCodexImportEntry(codexImportEntry{Index: 1, Value: raw})
	if err != nil {
		t.Fatalf("normalizeCodexImportEntry error = %v", err)
	}
	if item.Credentials["access_token"] != accessToken {
		t.Fatalf("access_token not stored")
	}
	if item.Credentials["email"] != "json@example.com" {
		t.Fatalf("email = %v, want json@example.com", item.Credentials["email"])
	}
	if item.Credentials["chatgpt_account_id"] != "acct-from-json" {
		t.Fatalf("chatgpt_account_id = %v, want acct-from-json", item.Credentials["chatgpt_account_id"])
	}
	if item.Credentials["chatgpt_user_id"] != "user-from-json" {
		t.Fatalf("chatgpt_user_id = %v, want user-from-json", item.Credentials["chatgpt_user_id"])
	}
	if item.Credentials["plan_type"] != "free" {
		t.Fatalf("plan_type = %v, want free", item.Credentials["plan_type"])
	}
	if _, ok := item.Credentials["session_token"]; ok {
		t.Fatalf("session_token should not be written to credentials")
	}
	if item.Extra["session_token_present"] != true {
		t.Fatalf("session_token_present = %v, want true", item.Extra["session_token_present"])
	}
	if item.Extra["session_expires_at"] != "2026-08-05T13:40:42Z" {
		t.Fatalf("session_expires_at = %v", item.Extra["session_expires_at"])
	}
	if item.TokenExpiresAt == nil {
		t.Fatalf("TokenExpiresAt should be parsed from accessToken")
	}
}

func TestMergeCodexImportCredentialsClearsStaleRefreshFieldsWhenIncomingHasNoRefreshToken(t *testing.T) {
	existing := map[string]any{
		"access_token":       "old-access-token",
		"refresh_token":      "old-refresh-token",
		"client_id":          "old-client-id",
		"id_token":           "old-id-token",
		"model_mapping":      map[string]any{"from": "existing"},
		"chatgpt_account_id": "acct-old",
		"unrelated_existing": "keep",
	}
	incoming := map[string]any{
		"access_token":       "new-access-token",
		"expires_at":         "2026-08-05T13:40:42Z",
		"chatgpt_account_id": "acct-new",
	}
	item := &codexImportAccount{
		AccessToken: "new-access-token",
	}

	merged := mergeCodexImportCredentials(existing, incoming, item)

	if merged["access_token"] != "new-access-token" {
		t.Fatalf("access_token = %v, want new-access-token", merged["access_token"])
	}
	if merged["chatgpt_account_id"] != "acct-new" {
		t.Fatalf("chatgpt_account_id = %v, want acct-new", merged["chatgpt_account_id"])
	}
	if _, ok := merged["refresh_token"]; ok {
		t.Fatalf("refresh_token should be cleared")
	}
	if _, ok := merged["client_id"]; ok {
		t.Fatalf("client_id should be cleared")
	}
	if _, ok := merged["id_token"]; ok {
		t.Fatalf("id_token should be cleared")
	}
	if merged["unrelated_existing"] != "keep" {
		t.Fatalf("unrelated_existing = %v, want keep", merged["unrelated_existing"])
	}
	if _, ok := merged["model_mapping"]; !ok {
		t.Fatalf("model_mapping should be preserved")
	}
}

func TestMergeCodexImportCredentialsKeepsRefreshFieldsWhenIncomingHasRefreshToken(t *testing.T) {
	existing := map[string]any{
		"refresh_token": "old-refresh-token",
		"client_id":     "old-client-id",
		"id_token":      "old-id-token",
	}
	incoming := map[string]any{
		"access_token":  "new-access-token",
		"refresh_token": "new-refresh-token",
		"client_id":     "new-client-id",
		"id_token":      "new-id-token",
	}
	item := &codexImportAccount{
		AccessToken:  "new-access-token",
		RefreshToken: "new-refresh-token",
		IDToken:      "new-id-token",
	}

	merged := mergeCodexImportCredentials(existing, incoming, item)

	if merged["refresh_token"] != "new-refresh-token" {
		t.Fatalf("refresh_token = %v, want new-refresh-token", merged["refresh_token"])
	}
	if merged["client_id"] != "new-client-id" {
		t.Fatalf("client_id = %v, want new-client-id", merged["client_id"])
	}
	if merged["id_token"] != "new-id-token" {
		t.Fatalf("id_token = %v, want new-id-token", merged["id_token"])
	}
}

func TestNormalizeCodexImportRejectsExpiredAccessToken(t *testing.T) {
	expiredToken := buildCodexImportTestJWT(t, time.Now().Add(-time.Hour), map[string]any{})

	_, err := normalizeCodexImportEntry(codexImportEntry{Index: 1, Value: expiredToken})
	if err == nil {
		t.Fatal("normalizeCodexImportEntry error = nil, want expired token error")
	}
	if !strings.Contains(err.Error(), "已过期") {
		t.Fatalf("error = %v, want expired token message", err)
	}
}

func TestResolveCodexImportExpiryForNoRefreshTokenUsesTokenExpiry(t *testing.T) {
	tokenExpiresAt := time.Now().Add(time.Hour).UTC()
	item := &codexImportAccount{
		AccessToken:    "access-token",
		Credentials:    map[string]any{"access_token": "access-token"},
		TokenExpiresAt: &tokenExpiresAt,
		WarningTexts:   []string{},
	}
	disabled := false
	req := CodexSessionImportRequest{AutoPauseOnExpired: &disabled}

	accountExpiresAt, credentialExpiresAt, autoPause, warnings, err := resolveCodexImportExpiry(req, item)
	if err != nil {
		t.Fatalf("resolveCodexImportExpiry error = %v", err)
	}
	if accountExpiresAt == nil || *accountExpiresAt != tokenExpiresAt.Unix() {
		t.Fatalf("account expires_at = %v, want %d", accountExpiresAt, tokenExpiresAt.Unix())
	}
	if credentialExpiresAt == nil || credentialExpiresAt.Unix() != tokenExpiresAt.Unix() {
		t.Fatalf("credential expires_at = %v, want %s", credentialExpiresAt, tokenExpiresAt)
	}
	if autoPause == nil || !*autoPause {
		t.Fatalf("autoPause = %v, want true", autoPause)
	}
	if len(warnings) == 0 {
		t.Fatalf("warnings should not be empty")
	}
}

func TestResolveCodexImportExpiryForNoRefreshTokenRequiresExpiry(t *testing.T) {
	item := &codexImportAccount{
		AccessToken:  "opaque-access-token",
		Credentials:  map[string]any{"access_token": "opaque-access-token"},
		WarningTexts: []string{},
	}

	_, _, _, _, err := resolveCodexImportExpiry(CodexSessionImportRequest{}, item)
	if err == nil {
		t.Fatal("resolveCodexImportExpiry error = nil, want missing expiry error")
	}
	if !strings.Contains(err.Error(), "无法解析 accessToken 过期时间") {
		t.Fatalf("error = %v, want missing expiry message", err)
	}
}

func TestResolveCodexImportExpiryForNoRefreshTokenUsesEarlierRequestExpiry(t *testing.T) {
	tokenExpiresAt := time.Now().Add(2 * time.Hour).UTC()
	requestExpiresAt := time.Now().Add(time.Hour).UTC()
	item := &codexImportAccount{
		AccessToken:    "access-token",
		Credentials:    map[string]any{"access_token": "access-token"},
		TokenExpiresAt: &tokenExpiresAt,
		WarningTexts:   []string{},
	}
	reqUnix := requestExpiresAt.Unix()
	req := CodexSessionImportRequest{ExpiresAt: &reqUnix}

	accountExpiresAt, credentialExpiresAt, _, _, err := resolveCodexImportExpiry(req, item)
	if err != nil {
		t.Fatalf("resolveCodexImportExpiry error = %v", err)
	}
	if accountExpiresAt == nil || *accountExpiresAt != requestExpiresAt.Unix() {
		t.Fatalf("account expires_at = %v, want %d", accountExpiresAt, requestExpiresAt.Unix())
	}
	if credentialExpiresAt == nil || credentialExpiresAt.Unix() != requestExpiresAt.Unix() {
		t.Fatalf("credential expires_at = %v, want %s", credentialExpiresAt, requestExpiresAt)
	}
}

func TestCodexIdentityKeysPreferStrongIdentifiers(t *testing.T) {
	keys := buildCodexIdentityKeys("acct-1", "user-1", "same@example.com", "token")
	for _, key := range keys {
		if strings.HasPrefix(key, "email:") {
			t.Fatalf("strong identity should not include email fallback: %v", keys)
		}
	}

	keys = buildCodexIdentityKeys("", "", "same@example.com", "token")
	hasEmail := false
	for _, key := range keys {
		if key == "email:same@example.com" {
			hasEmail = true
		}
	}
	if !hasEmail {
		t.Fatalf("weak identity should include email fallback: %v", keys)
	}
}

func buildCodexImportTestJWT(t *testing.T, exp time.Time, extraClaims map[string]any) string {
	t.Helper()
	header := map[string]any{
		"alg": "none",
		"typ": "JWT",
	}
	claims := map[string]any{
		"sub": "user-from-sub",
		"exp": exp.Unix(),
		"iat": time.Now().Unix(),
	}
	for k, v := range extraClaims {
		claims[k] = v
	}
	headerBytes, err := json.Marshal(header)
	if err != nil {
		t.Fatalf("marshal header: %v", err)
	}
	claimBytes, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(headerBytes) + "." + base64.RawURLEncoding.EncodeToString(claimBytes) + "."
}
