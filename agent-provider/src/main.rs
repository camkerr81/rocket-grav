//! Interactive Bitwarden Agent Access Provider Daemon
//!
//! Bridges Vaultwarden credentials to AI agents over a local relay with
//! dual interactive approval: Desktop D-Bus notifications + Rocket.Chat mobile action buttons.

use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ap_client::{
    CredentialData, CredentialRequestReply, DefaultRelayClient, FingerprintVerificationReply,
    MemoryConnectionStore, MemoryIdentityProvider, UserClient, UserClientRequest,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, oneshot};
use tracing::{error, info, warn};
use zeroize::Zeroizing;

const DEFAULT_RELAY_URL: &str = "ws://127.0.0.1:8089";
const DEFAULT_HTTP_PORT: u16 = 8090;
const DEFAULT_RC_URL: &str = "http://192.168.8.177:3100";
const DEFAULT_RC_USER_ID: &str = "zeCpyAPrXZPpfZts4"; // camkerr81

#[derive(Debug, Clone, Copy)]
pub enum ApprovalDecision {
    ApproveOnce,
    ApproveTimed(u64), // minutes
    Deny,
}

type PendingRequests = Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>;
type AutoApproveCache = Arc<Mutex<HashMap<String, Instant>>>;

fn check_and_unlock_if_needed() {
    if let Ok(status_out) = Command::new("bw").arg("status").output() {
        let json: serde_json::Value = serde_json::from_slice(&status_out.stdout).unwrap_or_default();
        if json["status"].as_str() == Some("locked") {
            info!("Vaultwarden is locked. Spawning secure Zenity password prompt on desktop...");
            if let Ok(zenity) = Command::new("zenity")
                .args(["--password", "--title=Unlock Vaultwarden"])
                .output()
            {
                let pass = String::from_utf8_lossy(&zenity.stdout).trim().to_string();
                if !pass.is_empty() {
                    if let Ok(unlock) = Command::new("bw")
                        .args(["unlock", "--passwordenv", "BW_PASS", "--raw"])
                        .env("BW_PASS", pass)
                        .output()
                    {
                        if unlock.status.success() {
                            let key = String::from_utf8_lossy(&unlock.stdout).trim().to_string();
                            unsafe { std::env::set_var("BW_SESSION", &key); }
                            info!("Vaultwarden successfully unlocked with session key.");
                        }
                    }
                }
            }
        }
    }
}

/// Look up credential from Bitwarden CLI (`bw get item <query>`)
fn lookup_bw_credential(query: &str) -> Option<CredentialData> {
    info!("Looking up credential in Vaultwarden for: {}", query);
    check_and_unlock_if_needed();

    let mut cmd = Command::new("bw");
    cmd.args(["get", "item", query]);
    if let Ok(session) = std::env::var("BW_SESSION") {
        cmd.env("BW_SESSION", session);
    }
    let output = cmd.output().ok()?;

    if !output.status.success() {
        warn!(
            "bw get item failed for '{}': {}",
            query,
            String::from_utf8_lossy(&output.stderr)
        );
        return None;
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let login = json.get("login")?;

    let username = login
        .get("username")
        .and_then(|v| v.as_str())
        .map(String::from);
    let password = login
        .get("password")
        .and_then(|v| v.as_str())
        .map(|s| Zeroizing::new(s.to_string()));
    let totp = login.get("totp").and_then(|v| v.as_str()).map(String::from);
    let item_id = json.get("id").and_then(|v| v.as_str()).map(String::from);

    let uri = login
        .get("uris")
        .and_then(|u| u.as_array())
        .and_then(|arr| arr.first())
        .and_then(|entry| entry.get("uri"))
        .and_then(|v| v.as_str())
        .map(String::from);

    Some(CredentialData {
        username,
        password,
        totp,
        uri,
        notes: None,
        credential_id: item_id,
        domain: Some(query.to_string()),
    })
}

/// Spawns a desktop notification with interactive action buttons via notify-send.
fn spawn_desktop_prompt(req_id: String, target: String, pending: PendingRequests) {
    tokio::task::spawn_blocking(move || {
        let title = "⣮⣵ Agent Access Approval Request";
        let body = format!(
            "Agent is requesting credentials for: {}\nRequest ID: {}\nExpires in 60s",
            target, req_id
        );

        let output = Command::new("notify-send")
            .args([
                "-A",
                "approve=Approve (Once)",
                "-A",
                "approve_15m=Approve (15m)",
                "-A",
                "deny=Deny",
                "-t",
                "60000",
                title,
                &body,
            ])
            .output();

        if let Ok(out) = output {
            let choice = String::from_utf8_lossy(&out.stdout).trim().to_string();
            info!("Desktop notification response for {}: '{}'", req_id, choice);

            let decision = match choice.as_str() {
                "approve" => Some(ApprovalDecision::ApproveOnce),
                "approve_15m" => Some(ApprovalDecision::ApproveTimed(15)),
                "deny" => Some(ApprovalDecision::Deny),
                _ => None,
            };

            if let Some(dec) = decision {
                let rt = tokio::runtime::Handle::current();
                rt.block_on(async {
                    let mut lock = pending.lock().await;
                    if let Some(tx) = lock.remove(&req_id) {
                        let _ = tx.send(dec);
                    }
                });
            }
        }
    });
}

/// Sends an interactive message with action buttons to Rocket.Chat.
async fn post_rocketchat_prompt(
    rc_url: &str,
    pat: &str,
    user_id: &str,
    req_id: &str,
    target: &str,
) {
    let payload = serde_json::json!({
        "roomId": user_id,
        "text": format!("⣮⣵ **Agent Access Approval Required** for `{}`", target),
        "attachments": [
            {
                "color": "#f59e0b",
                "title": format!("Credential Request: {}", target),
                "text": format!("• **Target Domain:** `{}`\n• **Requester:** `rocketgrav`\n• **Request ID:** `{}`\n• **Timeout:** 60 seconds", target, req_id),
                "actions": [
                    {
                        "type": "button",
                        "text": "[ ⢄⠎ ] Approve (Once)",
                        "msg": format!("!approve {} once", req_id),
                        "msg_in_chat_window": true
                    },
                    {
                        "type": "button",
                        "text": "[ ⢄⠎ ] Approve (15m)",
                        "msg": format!("!approve {} 15m", req_id),
                        "msg_in_chat_window": true
                    },
                    {
                        "type": "button",
                        "text": "[ ⡱⢎ ] Deny",
                        "msg": format!("!deny {}", req_id),
                        "msg_in_chat_window": true
                    }
                ]
            }
        ]
    });

    let client = reqwest_like_curl(
        &format!("{}/api/v1/chat.postMessage", rc_url),
        pat,
        user_id,
        &payload.to_string(),
    );
    if let Err(e) = client {
        warn!("Failed to post prompt to Rocket.Chat: {}", e);
    }
}

fn reqwest_like_curl(
    url: &str,
    pat: &str,
    user_id: &str,
    json_body: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let output = Command::new("curl")
        .args([
            "-s",
            "-X",
            "POST",
            url,
            "-H",
            &format!("X-Auth-Token: {}", pat),
            "-H",
            &format!("X-User-Id: {}", user_id),
            "-H",
            "Content-Type: application/json",
            "-d",
            json_body,
        ])
        .output()?;

    if !output.status.success() {
        return Err(format!(
            "curl failed: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(())
}

/// Lightweight HTTP callback listener for resolving approvals (e.g. from Rocket.Chat bot).
async fn run_http_callback_server(port: u16, pending: PendingRequests) {
    let addr = format!("0.0.0.0:{}", port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => {
            info!("Approval callback HTTP server listening on http://{}", addr);
            l
        }
        Err(e) => {
            error!("Failed to bind HTTP callback server on {}: {}", addr, e);
            return;
        }
    };

    loop {
        if let Ok((mut socket, _)) = listener.accept().await {
            let pending_ref = Arc::clone(&pending);
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                if let Ok(n) = socket.read(&mut buf).await {
                    let req_str = String::from_utf8_lossy(&buf[..n]);
                    let mut response = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";

                    if req_str.starts_with("GET /ping") {
                        response = "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\npong";
                    } else if req_str.contains("/approve") || req_str.contains("/deny") {
                        let is_approve = req_str.contains("/approve");
                        let is_15m = req_str.contains("15m") || req_str.contains("mins=15");

                        // Extract id from path e.g. /approve?id=req-xxxx or /approve/req-xxxx
                        let req_id = req_str
                            .lines()
                            .next()
                            .and_then(|line| {
                                let parts: Vec<&str> = line.split_whitespace().collect();
                                if parts.len() >= 2 {
                                    let path = parts[1];
                                    if let Some(pos) = path.find("id=") {
                                        return Some(
                                            path[pos + 3..]
                                                .split('&')
                                                .next()
                                                .unwrap_or("")
                                                .to_string(),
                                        );
                                    } else if let Some(last_seg) = path.split('/').last() {
                                        if last_seg.starts_with("req-") {
                                            return Some(last_seg.to_string());
                                        }
                                    }
                                }
                                None
                            })
                            .unwrap_or_default();

                        if !req_id.is_empty() {
                            let dec = if is_approve {
                                if is_15m {
                                    ApprovalDecision::ApproveTimed(15)
                                } else {
                                    ApprovalDecision::ApproveOnce
                                }
                            } else {
                                ApprovalDecision::Deny
                            };

                            let mut lock = pending_ref.lock().await;
                            if let Some(tx) = lock.remove(&req_id) {
                                let _ = tx.send(dec);
                                info!(
                                    "HTTP callback resolved {} as {:?}",
                                    req_id,
                                    if is_approve { "approved" } else { "denied" }
                                );
                                response =
                                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK";
                            } else {
                                response =
                                    "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found";
                            }
                        }
                    }

                    let _ = socket.write_all(response.as_bytes()).await;
                }
            });
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let relay_url =
        std::env::var("RELAY_URL").unwrap_or_else(|_| DEFAULT_RELAY_URL.to_string());
    let http_port: u16 = std::env::var("HTTP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_HTTP_PORT);
    let rc_url =
        std::env::var("ROCKETCHAT_URL").unwrap_or_else(|_| DEFAULT_RC_URL.to_string());
    let rc_user_id =
        std::env::var("ROCKETCHAT_USER_ID").unwrap_or_else(|_| DEFAULT_RC_USER_ID.to_string());
    let rc_pat = std::env::var("ROCKETCHAT_PAT").unwrap_or_default();

    let pending_requests: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
    let auto_approve_cache: AutoApproveCache = Arc::new(Mutex::new(HashMap::new()));

    // Start HTTP callback receiver
    tokio::spawn(run_http_callback_server(
        http_port,
        Arc::clone(&pending_requests),
    ));

    // Connect to local relay
    info!("Connecting to relay at {}", relay_url);
    let identity = Box::new(MemoryIdentityProvider::new());
    let session_store = Box::new(MemoryConnectionStore::new());
    let relay_client = Box::new(DefaultRelayClient::from_url(relay_url));

    let handle =
        UserClient::connect(identity, session_store, relay_client, None, None).await?;
    let client = handle.client;
    let mut requests = handle.requests;

    let psk_token = client.get_psk_token(None, false).await?;
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("⣮⣵ Bitwarden Agent Access Provider Daemon is ONLINE");
    println!("   PSK Pairing Token:");
    println!("   {}", psk_token);
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Persist token in ~/.access-protocol/provider-token.txt
    if let Some(home) = std::env::var_os("HOME") {
        let token_dir = std::path::Path::new(&home).join(".access-protocol");
        let _ = std::fs::create_dir_all(&token_dir);
        let _ = std::fs::write(token_dir.join("provider-token.txt"), &psk_token);
    }

    let mut req_counter = 1000u64;

    while let Some(request) = requests.recv().await {
        match request {
            UserClientRequest::VerifyFingerprint { fingerprint, reply, .. } => {
                info!("Auto-verifying remote container fingerprint: {}", fingerprint);
                let _ = reply.send(FingerprintVerificationReply {
                    approved: true,
                    name: Some("rocketgrav-container".to_string()),
                });
            }

            UserClientRequest::CredentialRequest { query, reply, .. } => {
                let target_domain = query.search_string().to_string();
                info!("Received credential request for domain: '{}'", target_domain);

                // 1. Check auto-approve cache
                let is_cached = {
                    let mut cache = auto_approve_cache.lock().await;
                    if let Some(expiry) = cache.get(&target_domain) {
                        if Instant::now() < *expiry {
                            true
                        } else {
                            cache.remove(&target_domain);
                            false
                        }
                    } else {
                        false
                    }
                };

                if is_cached {
                    info!("Domain '{}' is cached/auto-approved. Looking up credential directly.", target_domain);
                    let cred = lookup_bw_credential(&target_domain);
                    let cred_id = cred.as_ref().and_then(|c| c.credential_id.clone());
                    let approved = cred.is_some();
                    let _ = reply.send(CredentialRequestReply {
                        approved,
                        credential: cred,
                        credential_id: cred_id,
                    });
                    continue;
                }

                // 2. Generate unique request ID
                req_counter += 1;
                let req_id = format!("req-{}", req_counter);
                let (tx, rx) = oneshot::channel();

                {
                    let mut lock = pending_requests.lock().await;
                    lock.insert(req_id.clone(), tx);
                }

                // 3. Dispatch concurrent prompts (Desktop + Rocket.Chat)
                info!("Dispatching dual-approval prompts for {}", req_id);
                spawn_desktop_prompt(
                    req_id.clone(),
                    target_domain.clone(),
                    Arc::clone(&pending_requests),
                );

                if !rc_pat.is_empty() {
                    let r_url = rc_url.clone();
                    let r_pat = rc_pat.clone();
                    let r_uid = rc_user_id.clone();
                    let r_id = req_id.clone();
                    let r_target = target_domain.clone();
                    tokio::spawn(async move {
                        post_rocketchat_prompt(&r_url, &r_pat, &r_uid, &r_id, &r_target).await;
                    });
                }

                // 4. Await user decision (with 60-second timeout)
                let decision = match tokio::time::timeout(Duration::from_secs(60), rx).await {
                    Ok(Ok(d)) => d,
                    Ok(Err(_)) => {
                        warn!("Approval channel closed unexpectedly for {}", req_id);
                        ApprovalDecision::Deny
                    }
                    Err(_) => {
                        warn!("Approval timed out after 60s for {}", req_id);
                        let mut lock = pending_requests.lock().await;
                        lock.remove(&req_id);
                        ApprovalDecision::Deny
                    }
                };

                // 5. Handle decision
                match decision {
                    ApprovalDecision::ApproveOnce => {
                        info!("Request {} APPROVED (once)", req_id);
                        let cred = lookup_bw_credential(&target_domain);
                        let cred_id = cred.as_ref().and_then(|c| c.credential_id.clone());
                        let approved = cred.is_some();
                        let _ = reply.send(CredentialRequestReply {
                            approved,
                            credential: cred,
                            credential_id: cred_id,
                        });
                    }
                    ApprovalDecision::ApproveTimed(mins) => {
                        info!("Request {} APPROVED for {} minutes", req_id, mins);
                        {
                            let mut cache = auto_approve_cache.lock().await;
                            cache.insert(
                                target_domain.clone(),
                                Instant::now() + Duration::from_secs(mins * 60),
                            );
                        }
                        let cred = lookup_bw_credential(&target_domain);
                        let cred_id = cred.as_ref().and_then(|c| c.credential_id.clone());
                        let approved = cred.is_some();
                        let _ = reply.send(CredentialRequestReply {
                            approved,
                            credential: cred,
                            credential_id: cred_id,
                        });
                    }
                    ApprovalDecision::Deny => {
                        warn!("Request {} DENIED", req_id);
                        let _ = reply.send(CredentialRequestReply {
                            approved: false,
                            credential: None,
                            credential_id: None,
                        });
                    }
                }
            }
        }
    }

    Ok(())
}
