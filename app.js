const BSC_TESTNET_CHAIN_ID = 97;
const STAKING_ADDRESS = "0xEDBC01b07ab9bD0758c1FBAfdafdC71454C12659";
const EXPECTED_TOKEN_ADDRESS = "0xd96eaEb41474F1325eF399f6F5fc54AA71f09bac";

const STAKING_ABI = [
  "function stakeToken() view returns (address)",
  "function deposit(uint256 amount)",
  "function depositWithReferrer(uint256 amount, address referrerAddr)",
  "function getReferrer(address user) view returns (address)",
  "function firstUser() view returns (address)",
  "function previewNetAndInterest(uint256 grossAmount) view returns (bool valid,uint256 totalFee,uint256 netAmount,uint256 duration,uint256 totalRateBP,uint256 interestAmount,uint256 payoutAmount)",
  "function getStakesCount(address user) view returns (uint256)",
  "function getStake(address user,uint256 stakeId) view returns (tuple(uint256 amount,uint256 startTs,uint256 duration,bool withdrawn,bool active,uint256 rateBP,uint256 interestAmount))",
  "function getContractTokenBalance() view returns (uint256)",
  "function manualWithdrawMatured(uint256 stakeId)",
  "function withdrawWithPressStake(uint256 oldStakeId,uint256 newStakeGrossAmount)",
  "function claimAgentRewards()"
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];

let provider;
let signer;
let userAddress;
let staking;
let token;
let tokenDecimals = 18;
let isConnected = false;
let listenersBound = false;
let injectedEthereum;

function getInjectedEthereum() {
  const eth = window.ethereum;
  if (!eth) return null;

  // Some wallets (e.g., TokenPocket/MetaMask) may expose multiple providers.
  const providers = Array.isArray(eth.providers) ? eth.providers : null;
  if (providers && providers.length > 0) {
    const tokenPocket = providers.find((p) => p && p.isTokenPocket);
    if (tokenPocket) return tokenPocket;

    const metaMask = providers.find((p) => p && p.isMetaMask);
    if (metaMask) return metaMask;

    return providers[0];
  }

  return eth;
}

const CUSTOM_ERROR_MESSAGES = {
  MinDeposit: "质押金额低于最小限制（当前最小 1 LINK）",
  InvalidMultiple: "质押金额必须是 1 LINK 的整数倍",
  AmountExceedsMax: "质押金额超过单笔上限",
  MaxStakesExceeded: "该地址已达到最大质押笔数",
  ActiveStakeNotMatured: "当前有未到期有效质押，暂不可再次质押",
  CannotReferSelf: "不能绑定自己为推荐人",
  ReferrerMustHaveStake: "推荐人必须有有效质押",
  ReferrerRequired: "非首位用户必须绑定推荐人",
  CircularReference: "推荐关系存在循环，绑定失败",
  AlreadyInDownline: "该关系已在下级网络中，不能重复绑定",
  ContractAddressNotAllowed: "仅允许普通钱包地址参与（合约地址被禁止）",
  ReferrerContractNotAllowed: "推荐人不能是合约地址",
  NotAuthorized: "当前地址无权限执行该操作",
  InvalidStakeId: "stakeId 无效",
  StakeNotActive: "该质押单不是有效状态",
  StakeNotMatured: "该质押单尚未到期",
  CannotWithdrawLastStake: "最后一笔有效质押不可直接提取",
  InsufficientRestake: "新质押金额不足，无法满足压单条件",
  InsufficientPoolBalance: "合约池余额不足，暂无法发放",
  NoPendingRewards: "当前没有可领取的代理奖励",
  TokenTransferFromFailed: "代币扣款失败（请检查授权额度和余额）",
  TokenTransferFailed: "代币转账失败",
  FeeWallet3MustBeBlackhole: "fee3 地址必须是黑洞地址"
};

const CUSTOM_ERROR_SELECTORS = Object.fromEntries(
  Object.keys(CUSTOM_ERROR_MESSAGES).map((name) => [
    ethers.utils.id(`${name}()`).slice(0, 10).toLowerCase(),
    name
  ])
);

const $ = (id) => document.getElementById(id);

function setConnectedUI(connected) {
  isConnected = connected;
  const btn = $("connectBtn");
  if (btn) btn.textContent = connected ? "断开连接" : "连接钱包";
}

function resetUI() {
  $("wallet").textContent = "未连接";
  $("network").textContent = "未知";
  $("linkBalance").textContent = "-";
  $("allowance").textContent = "-";
  $("myStakeCount").textContent = "-";
  $("poolBalance").textContent = "-";

  const detail = $("stakeDetail");
  if (detail) detail.textContent = "-";

  // preview fields
  const pvIds = ["pvValid", "pvBase", "pvDuration", "pvRate", "pvInterest", "pvPayout"];
  for (const id of pvIds) {
    const el = $(id);
    if (el) el.textContent = "-";
  }
}

function disconnectWallet() {
  provider = null;
  signer = null;
  userAddress = null;
  staking = null;
  token = null;
  tokenDecimals = 18;
  setConnectedUI(false);
  resetUI();
  log("已断开连接（前端状态已清空）");
  toast("success", "已断开连接");
}

async function requireCorrectNetwork() {
  if (!provider) throw new Error("请先连接钱包");
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== BSC_TESTNET_CHAIN_ID) {
    throw new Error("当前网络不是 BSC 测试网（chainId=97），请先切换网络");
  }
}

function isGasTooLowError(errorObj) {
  const code = errorObj?.code;
  const msg = String(errorObj?.message || errorObj || "");
  return (
    code === -32000 &&
    /gas price below minimum|gas tip cap .* below minimum|minimum needed/i.test(msg)
  );
}

async function sendTxAdaptive(sendDefault, sendWithOverrides) {
  try {
    return await sendDefault();
  } catch (e) {
    if (!provider || !isGasTooLowError(e)) throw e;

    const feeData = await provider.getFeeData();
    const minTip = ethers.utils.parseUnits("1", "gwei");
    const baseFee = feeData.lastBaseFeePerGas || feeData.gasPrice || (await provider.getGasPrice());
    const priorityFee = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minTip)
      ? feeData.maxPriorityFeePerGas
      : minTip;
    const maxFee = baseFee.mul(2).add(priorityFee);

    log(
      `检测到 gas 过低，自动重试：maxFee ${ethers.utils.formatUnits(maxFee, "gwei")} gwei, ` +
      `priority ${ethers.utils.formatUnits(priorityFee, "gwei")} gwei`
    );

    return await sendWithOverrides({
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee
    });
  }
}

function log(message) {
  const target = $("log");
  const now = new Date().toLocaleTimeString();
  target.textContent = `[${now}] ${message}\n` + target.textContent;
}

function toast(type, message) {
  const container = $("toastContainer");
  if (!container) return;
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  container.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, 2600);
}

function extractErrorData(errorObj) {
  if (!errorObj) return "";
  if (typeof errorObj === "string" && errorObj.startsWith("0x")) return errorObj;
  if (typeof errorObj.data === "string" && errorObj.data.startsWith("0x")) return errorObj.data;
  if (errorObj.data && typeof errorObj.data === "object") {
    const nestedData = extractErrorData(errorObj.data);
    if (nestedData) return nestedData;
  }
  if (errorObj.error) {
    const nested = extractErrorData(errorObj.error);
    if (nested) return nested;
  }
  if (errorObj.receipt && typeof errorObj.receipt.revertString === "string") {
    return errorObj.receipt.revertString;
  }
  return "";
}

async function hasActiveStake(addressToCheck) {
  const count = await staking.getStakesCount(addressToCheck);
  const total = Number(count.toString());
  if (total <= 0) return false;

  const start = Math.max(0, total - 10);
  for (let i = total - 1; i >= start; i--) {
    const s = await staking.getStake(addressToCheck, i);
    if (s.active && !s.withdrawn && s.amount.gt(0)) {
      return true;
    }
  }
  return false;
}

function decodeCustomError(errorObj) {
  const rawData = extractErrorData(errorObj);
  const text = String(errorObj?.message || errorObj || "");

  let selector = "";
  if (rawData && rawData.startsWith("0x") && rawData.length >= 10) {
    selector = rawData.slice(0, 10).toLowerCase();
  } else {
    const match = text.match(/0x[0-9a-fA-F]{8}/);
    if (match) selector = match[0].toLowerCase();
  }

  if (!selector) return null;
  const errorName = CUSTOM_ERROR_SELECTORS[selector];
  if (!errorName) return null;
  return {
    errorName,
    message: CUSTOM_ERROR_MESSAGES[errorName]
  };
}

function formatActionError(actionLabel, errorObj) {
  if (errorObj?.code === 4001) {
    return `${actionLabel}已取消（用户拒绝签名）`;
  }

  const decoded = decodeCustomError(errorObj);
  if (decoded) {
    return `${actionLabel}失败：${decoded.message} (${decoded.errorName})`;
  }

  return `${actionLabel}失败：${errorObj?.message || errorObj}`;
}

function parseAmount(input) {
  const raw = input.trim();
  if (!raw) throw new Error("请输入数量");
  return ethers.utils.parseUnits(raw, tokenDecimals);
}

function formatAmount(value) {
  return ethers.utils.formatUnits(value, tokenDecimals);
}

async function connectWallet() {
  injectedEthereum = getInjectedEthereum();
  if (!injectedEthereum) {
    throw new Error("未检测到钱包插件（可用 MetaMask / TokenPocket 内置浏览器打开）");
  }

  // Use "any" network so ethers doesn't get stuck on chain changes.
  provider = new ethers.providers.Web3Provider(injectedEthereum, "any");
  await provider.send("eth_requestAccounts", []);
  signer = provider.getSigner();
  userAddress = await signer.getAddress();

  const stakingCode = await provider.getCode(STAKING_ADDRESS);
  if (!stakingCode || stakingCode === "0x") {
    log(`警告：合约地址没有代码（可能网络不对或地址错误）: ${STAKING_ADDRESS}`);
    toast("error", "警告：合约地址没有代码，请确认网络与合约地址");
  }

  staking = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer);
  const tokenAddr = await staking.stakeToken();

  if (String(tokenAddr).toLowerCase() !== String(EXPECTED_TOKEN_ADDRESS).toLowerCase()) {
    log(`警告：stakeToken 与预期不一致。stakeToken=${tokenAddr} 预期=${EXPECTED_TOKEN_ADDRESS}`);
    toast("error", "警告：合约代币地址与预期不一致，请确认是否连错合约");
  }

  token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
  try {
    tokenDecimals = Number(await token.decimals());
  } catch (e) {
    tokenDecimals = 18;
    log("读取 decimals 失败，已回退为18");
  }

  $("wallet").textContent = userAddress;
  await refreshNetwork();
  await refreshMyData();
  log("钱包连接成功");
  log(`当前合约: ${STAKING_ADDRESS}`);

  setConnectedUI(true);

  if (!listenersBound) {
    listenersBound = true;
    try {
      injectedEthereum.on("accountsChanged", async (accounts) => {
        if (!accounts || accounts.length === 0) {
          disconnectWallet();
          return;
        }
        // account switched
        try {
          signer = provider.getSigner();
          userAddress = await signer.getAddress();
          staking = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, signer);
          const tokenAddr = await staking.stakeToken();
          token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
          $("wallet").textContent = userAddress;
          await refreshNetwork();
          await refreshMyData();
          log("检测到账号切换，已刷新状态");
        } catch (e) {
          log(`账号切换后刷新失败: ${e?.message || e}`);
        }
      });

      injectedEthereum.on("chainChanged", async () => {
        try {
          await refreshNetwork();
          if (isConnected) await refreshMyData();
          log("检测到网络切换，已刷新状态");
        } catch (e) {
          log(`网络切换后刷新失败: ${e?.message || e}`);
        }
      });
    } catch (e) {
      // ignore listener errors
    }
  }
}

async function toggleConnect() {
  if (isConnected) {
    disconnectWallet();
    return;
  }
  await connectWallet();
}

async function refreshNetwork() {
  const net = await provider.getNetwork();
  const text = `${net.name} (chainId=${net.chainId})`;
  $("network").textContent = text;
  if (Number(net.chainId) !== BSC_TESTNET_CHAIN_ID) {
    log("警告：当前不在 BSC 测试网");
  }
}

async function switchToBscTestnet() {
  const eth = injectedEthereum || getInjectedEthereum();
  if (!eth) throw new Error("未检测到钱包插件");
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x61" }]
    });
  } catch (err) {
    if (err.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x61",
          chainName: "BSC Testnet",
          nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
          rpcUrls: ["https://data-seed-prebsc-1-s1.binance.org:8545/"],
          blockExplorerUrls: ["https://testnet.bscscan.com"]
        }]
      });
    } else {
      throw err;
    }
  }
  if (provider) await refreshNetwork();
  log("网络已切换/添加到 BSC 测试网");
}

async function refreshMyData() {
  if (!signer || !staking || !token) throw new Error("请先连接钱包");
  try {
    const balance = await token.balanceOf(userAddress);
    $("linkBalance").textContent = formatAmount(balance);
  } catch (e) {
    $("linkBalance").textContent = "读取失败";
    log(`读取LINK余额失败: ${e.message || e}`);
  }

  try {
    const allowance = await token.allowance(userAddress, STAKING_ADDRESS);
    $("allowance").textContent = formatAmount(allowance);
  } catch (e) {
    $("allowance").textContent = "读取失败";
    log(`读取授权额度失败: ${e.message || e}`);
  }

  try {
    const count = await staking.getStakesCount(userAddress);
    $("myStakeCount").textContent = count.toString();
  } catch (e) {
    $("myStakeCount").textContent = "读取失败";
    log(`读取Stake数量失败: ${e.message || e}`);
  }

  try {
    const pool = await staking.getContractTokenBalance();
    $("poolBalance").textContent = formatAmount(pool);
  } catch (e) {
    $("poolBalance").textContent = "读取失败";
    log(`读取池子余额失败: ${e.message || e}`);
  }
}

async function approve() {
  await requireCorrectNetwork();
  const amount = parseAmount($("amount").value);

  const tx = await sendTxAdaptive(
    () => token.approve(STAKING_ADDRESS, amount),
    (overrides) => token.approve(STAKING_ADDRESS, amount, overrides)
  );
  log(`授权已发送: ${tx.hash}`);
  await tx.wait();
  log("授权成功");
  toast("success", "授权成功");
  await refreshMyData();
}

async function deposit() {
  await requireCorrectNetwork();
  const amount = parseAmount($("amount").value);

  const [myReferrer, firstUserAddr, allowance, balance] = await Promise.all([
    staking.getReferrer(userAddress),
    staking.firstUser(),
    token.allowance(userAddress, STAKING_ADDRESS),
    token.balanceOf(userAddress)
  ]);

  if (balance.lt(amount)) {
    throw new Error("余额不足，请先确保钱包有足够 LINK");
  }

  if (allowance.lt(amount)) {
    throw new Error("授权额度不足，请先点击授权");
  }

  const zero = ethers.constants.AddressZero;
  const firstUserIsSet = String(firstUserAddr).toLowerCase() !== zero.toLowerCase();
  const isFirstUser = firstUserIsSet && userAddress.toLowerCase() === String(firstUserAddr).toLowerCase();
  const hasReferrer = String(myReferrer).toLowerCase() !== zero.toLowerCase();
  // 如果合约尚未产生全网 firstUser（firstUser=0x0），任何地址都有可能成为首位用户，不应在前端拦截。
  if (firstUserIsSet && !isFirstUser && !hasReferrer) {
    throw new Error("你尚未绑定推荐人，请使用“带推荐人质押”完成首次绑定");
  }

  const tx = await sendTxAdaptive(
    () => staking.deposit(amount),
    (overrides) => staking.deposit(amount, overrides)
  );
  log(`质押交易已发送: ${tx.hash}`);
  await tx.wait();
  log("质押成功");
  toast("success", "质押成功");
  await refreshMyData();
}

async function depositWithReferrer() {
  await requireCorrectNetwork();
  const amount = parseAmount($("amount").value);
  const referrer = $("referrer").value.trim();
  if (!ethers.utils.isAddress(referrer)) throw new Error("推荐人地址无效");

  const [allowance, balance, refValid] = await Promise.all([
    token.allowance(userAddress, STAKING_ADDRESS),
    token.balanceOf(userAddress),
    hasActiveStake(referrer)
  ]);

  if (balance.lt(amount)) {
    throw new Error("余额不足，请先确保钱包有足够 LINK");
  }

  if (allowance.lt(amount)) {
    throw new Error("授权额度不足，请先点击授权");
  }

  if (!refValid) {
    throw new Error("推荐人在当前合约下没有有效质押，无法绑定");
  }

  const tx = await sendTxAdaptive(
    () => staking.depositWithReferrer(amount, referrer),
    (overrides) => staking.depositWithReferrer(amount, referrer, overrides)
  );
  log(`带推荐质押已发送: ${tx.hash}`);
  await tx.wait();
  log("带推荐质押成功");
  toast("success", "质押成功（已绑定推荐关系）");
  await refreshMyData();
}

async function preview() {
  const amount = parseAmount($("amount").value);
  const result = await staking.previewNetAndInterest(amount);
  const pvValid = $("pvValid");
  if (pvValid) pvValid.textContent = String(result.valid);

  const base99 = amount.mul(9900).div(10000);
  const pvBase = $("pvBase");
  if (pvBase) pvBase.textContent = formatAmount(base99);

  const pvDuration = $("pvDuration");
  if (pvDuration) pvDuration.textContent = result.duration.toString();

  const pvRate = $("pvRate");
  if (pvRate) pvRate.textContent = result.totalRateBP.toString();

  const pvInterest = $("pvInterest");
  if (pvInterest) pvInterest.textContent = formatAmount(result.interestAmount);

  const pvPayout = $("pvPayout");
  if (pvPayout) pvPayout.textContent = formatAmount(result.payoutAmount);
}

async function manualWithdraw() {
  await requireCorrectNetwork();
  const id = Number($("withdrawStakeId").value);
  if (Number.isNaN(id) || id < 0) throw new Error("stakeId 无效");
  const tx = await sendTxAdaptive(
    () => staking.manualWithdrawMatured(id),
    (overrides) => staking.manualWithdrawMatured(id, overrides)
  );
  log(`手动提现已发送: ${tx.hash}`);
  await tx.wait();
  log("手动提现成功");
  toast("success", "手动提现成功");
  await refreshMyData();
}

async function pressWithdraw() {
  await requireCorrectNetwork();
  const oldId = Number($("pressOldId").value);
  const newAmount = parseAmount($("pressNewAmount").value);
  if (Number.isNaN(oldId) || oldId < 0) throw new Error("oldStakeId 无效");
  const tx = await sendTxAdaptive(
    () => staking.withdrawWithPressStake(oldId, newAmount),
    (overrides) => staking.withdrawWithPressStake(oldId, newAmount, overrides)
  );
  log(`压单提现已发送: ${tx.hash}`);
  await tx.wait();
  log("压单提现成功");
  toast("success", "压单提现成功");
  await refreshMyData();
}

async function claimAgent() {
  await requireCorrectNetwork();
  const tx = await sendTxAdaptive(
    () => staking.claimAgentRewards(),
    (overrides) => staking.claimAgentRewards(overrides)
  );
  log(`领取代理奖励已发送: ${tx.hash}`);
  await tx.wait();
  log("领取代理奖励成功");
  toast("success", "领取代理奖励成功");
  await refreshMyData();
}

async function queryStake() {
  const id = Number($("queryStakeId").value);
  if (Number.isNaN(id) || id < 0) throw new Error("stakeId 无效");
  const s = await staking.getStake(userAddress, id);
  $("stakeDetail").textContent = JSON.stringify({
    amount: formatAmount(s.amount),
    startTs: s.startTs.toString(),
    duration: s.duration.toString(),
    withdrawn: s.withdrawn,
    active: s.active,
    rateBP: s.rateBP.toString(),
    interestAmount: formatAmount(s.interestAmount)
  }, null, 2);
}

async function run(actionLabel, action) {
  try {
    await action();
  } catch (e) {
    const msg = formatActionError(actionLabel, e);
    log(msg);
    toast("error", msg);
  }
}

$("connectBtn").onclick = () => run(isConnected ? "断开连接" : "连接钱包", toggleConnect);
$("switchChainBtn").onclick = () => run("切换网络", switchToBscTestnet);
$("refreshMyBtn").onclick = () => run("刷新数据", refreshMyData);
$("approveBtn").onclick = () => run("授权", approve);
$("depositBtn").onclick = () => run("直接质押", deposit);
$("depositWithRefBtn").onclick = () => run("带推荐质押", depositWithReferrer);
$("previewBtn").onclick = () => run("预览收益", preview);
$("manualWithdrawBtn").onclick = () => run("手动提现", manualWithdraw);
$("pressWithdrawBtn").onclick = () => run("压单提现", pressWithdraw);
$("claimAgentBtn").onclick = () => run("领取代理奖励", claimAgent);
$("queryStakeBtn").onclick = () => run("查询质押", queryStake);

// Initialize
setConnectedUI(false);
resetUI();
