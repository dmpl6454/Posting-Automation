#!/bin/bash
# ══════════════════════════════════════════════════════════════════
# PostAutomation — First-time Linode Server Setup
# Run this ONCE on a fresh Ubuntu 22.04/24.04 Linode instance
# Usage: ssh root@YOUR_LINODE_IP < scripts/server-setup.sh
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

DOMAIN="postautomation.co.in"
APP_USER="deploy"
APP_DIR="/home/${APP_USER}/postautomation"

echo "═══════════════════════════════════════════════════"
echo "  PostAutomation — Server Setup Starting"
echo "═══════════════════════════════════════════════════"

# ── 1. System updates ────────────────────────────────────────────
echo "[1/8] Updating system packages..."
apt-get update -y && apt-get upgrade -y
apt-get install -y \
  curl wget git ufw fail2ban \
  ca-certificates gnupg lsb-release \
  htop ncdu tree jq unzip

# ── 2. Create deploy user ───────────────────────────────────────
echo "[2/8] Creating deploy user..."
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${APP_USER}"
  usermod -aG sudo "${APP_USER}"
  echo "${APP_USER} ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/deploy
  # Copy SSH keys from root
  mkdir -p /home/${APP_USER}/.ssh
  cp /root/.ssh/authorized_keys /home/${APP_USER}/.ssh/
  chown -R ${APP_USER}:${APP_USER} /home/${APP_USER}/.ssh
  chmod 700 /home/${APP_USER}/.ssh
  chmod 600 /home/${APP_USER}/.ssh/authorized_keys
fi

# ── 3. Firewall ─────────────────────────────────────────────────
echo "[3/8] Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp    # HTTP (for Let's Encrypt + redirect)
ufw allow 443/tcp   # HTTPS
ufw --force enable

# ── 4. Install Docker ───────────────────────────────────────────
echo "[4/8] Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "${APP_USER}"
fi

# Install Docker Compose plugin
if ! docker compose version &>/dev/null; then
  apt-get install -y docker-compose-plugin
fi

# Enable Docker to start on boot
systemctl enable docker
systemctl start docker

# ── 5. Configure Fail2Ban ────────────────────────────────────────
echo "[5/8] Configuring Fail2Ban..."
cat > /etc/fail2ban/jail.local << 'JAIL'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
JAIL

systemctl enable fail2ban
systemctl restart fail2ban

# ── 6. Setup swap (if less than 4GB RAM) ────────────────────────
echo "[6/8] Checking swap..."
TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
if [ "$TOTAL_MEM" -lt 4096 ] && [ ! -f /swapfile ]; then
  echo "Setting up 2GB swap..."
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl vm.swappiness=10
  echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

# ── 7. Create application directory ─────────────────────────────
echo "[7/8] Creating application directory..."
mkdir -p "${APP_DIR}"
chown -R ${APP_USER}:${APP_USER} "${APP_DIR}"

# ── 8. SSH hardening ────────────────────────────────────────────
echo "[8/8] Hardening SSH..."
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/#PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart sshd

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Server Setup Complete!"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Point DNS A record for ${DOMAIN} to this server's IP"
echo "  2. Point DNS A record for www.${DOMAIN} to this server's IP"
echo "  3. SSH as deploy user: ssh ${APP_USER}@YOUR_LINODE_IP"
echo "  4. Clone your repo into ${APP_DIR}"
echo "  5. Run: cd ${APP_DIR} && bash scripts/deploy.sh setup"
echo ""
