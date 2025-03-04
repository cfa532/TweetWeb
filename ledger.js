/**
 Leither是一个应用容器，容器可以执行js代码
容器在执行js代码时会设置全局变量
全局变量lapi挂接系统的所有api,可以调用容器的所有的系统功能
全局变量request是一个map类型，是kv类型的参数，key value都是字符串
args是一个数组，依次存放传入的各种参数

 */

((request, args)=>{
	const mark 				= "ledger"

	//新版本的key
	const HKeySelfSum3 		= "selfsum" 	//自己汇总 //这是新的key
	const KeyLogRecv3	 	= "recv" 		//新的key
	const HKeyFriSumm3 		= "frisum" 		//好友传过来的汇总
	const HKeyFriRecv3 		= "frirecv"

	//用于汇总签名信息
	const KeyTotalSize3 	= "TotalSize"
	const KeyTotalCount3 	= "TotalCount"

	//新旧兼容的key
	const KeyLogSent 		= "sent"
	const HKeySelfRecv 		= "selfrecv" 	//暂时新旧兼容，容易会有垃圾数据，有冲突就清理

	//旧版本等移除的key
	const KeyLogReceived 	= "received"	//旧的key,目前升级数据库还需要
	const KeyAppInfo 		= ".appinfo"
	const FieldCheckTime 	= "CheckTime"
	const FieldLastSeqCheck = "lastcheckseq" //不用了，观察一下后续去除. 好象还在使用250217
	//const FieldLastSeqClear = "lastseqclear"

	function has(v) {
		return v != null && v !== ""
	}

	function isEmpty(v) {
		return v == null || v === ""
	}

	//应用id,这个应该当成全局变量，到处要用的
	let appid = request.aid;
	if (appid != '9QHDgCSdxWYPFyd4XxJz7DQasam') {
		throw new Error("appid != '9QHDgCSdxWYPFyd4XxJz7DQasam'");
	}
	
	function creditShow2(sid, fri){
		// console.log("creditShow2 fri=", fri, "sid" , sid)
		
		if (isEmpty(fri)){
			throw new Error("fri is empty")
		} 	

		// console.log("creditShow2 fri=", fri, "sid" , sid)
		let mmsidnode = openLedgerNode()
		try {
			let [seqsign, mapLedger] = getLedgerMap3(mmsidnode, HKeySelfSum3 + fri, -1)
			// console.log("creditShow2 seqsign=", seqsign)
			return mapLedger
		} finally {
			lapi.MMClose(mmsidnode)
		}
	}

	//读取所有的pid
	//这些数据在创建弥媒时已经写入，通过mark标识进行索引
	function getPids(sid, owner){
		//这里后续换appid
		//'9QHDgCSdxWYPFyd4XxJz7DQasam'
		return lapi.GetVar(sid, 'appdata', owner, appid, '_AppData_User')
	}
		
	//打开弥媒
	function openLedger(sid = "", pid) {
		const owner = sid === "" ? lapi.GetVar("", "hostid") : ""
		return lapi.MMOpenAppData(sid, appid, "user", owner, "cur", mark + pid)
	}
	
	function  openLedgerNode(){	
		return lapi.BEOpenAppDataNode("cur", mark)
	}

	function getZCount2(mmsid, pid) {
		if (!mmsid || !pid) {
			console.log("getZCount2: Invalid parameters - mmsid or pid is missing")
			return {}
		}

		try {
			const ret = {
				sent: lapi.Zcard(mmsid, KeyLogSent + pid),
				received: lapi.Zcard(mmsid, KeyLogRecv3 + pid)
			}

			console.log(`getZCount2: pid=${pid}, sent=${ret.sent}, received=${ret.received}`)
			return ret
		} catch(e) {
			console.log(`getZCount2: Error getting count for pid=${pid}:`, e)
			return {}
		}
	}

	function getZCounts(mmsid) {
		const owner = lapi.GetVar("", "hostid")
		console.log("owner=", owner)
		
		const pids = getPids(request.sid, owner)
		const ret = {}
		console.log("pids=", pids.length)
		
		pids.forEach(pid => {
			// 处理 pid 格式
			let processedPid = pid.startsWith(mark) ? pid.substring(mark.length) : pid
			
			// 验证 pid 长度
			if (processedPid.length !== 27) {
				console.log("Invalid pid length:", processedPid.length)
				return // continue in forEach
			}
			
			// 只在 pid 不存在时获取计数
			if (!(processedPid in ret)) {
				ret[processedPid] = getZCount2(mmsid, processedPid)
			}
		})
		
		return ret
	}

	//当前的命令Leither stat ledger count <pid>
	function getLedgerZCount() {
		console.log("getLedgerZCount")
		let mmsid = null
		try {
			mmsid = openLedgerNode()
			if (!mmsid) {
				throw new Error("Failed to open ledger node")
			}
			
			return isEmpty(request.pid) ? getZCounts(mmsid) : getZCount2(mmsid, request.pid)
		} catch (e) {
			console.log("getLedgerZCount error:", e)
			throw e
		} finally {
			if (mmsid) {
				lapi.MMClose(mmsid)
			}
		}
	}

	function parseSizeFromMember(member){
		let ay = member.split(";");
		if (ay.length < 2){
			return 0
		}

		let str = ay[1]
		return parseInt(str, 16);
	}

	function ledger2Db(mmsidnode, tpLedger, strLedger, checkSumInfo){
		//验证
		// console.log("ledger2Db SignInfo2Map")
		let ledger = lapi.SignInfo2Map(strLedger)
		console.log("ledger2Db Sender=", ledger.Sender)
		console.log("ledger2Db Receiver=", ledger.Receiver)
		console.log("ledger2Db SeqEnd=", ledger.SeqEnd)
		// console.log("ledger2Db SeqSender=", ledger.SeqSender)

		let seqEnd = ledger.SeqEnd
		if (checkSumInfo != null){
			if (!checkSumInfo(ledger)){
				return -1
			}
		}
		// console.log("seqEnd=", seqEnd, "tpLedger=", tpLedger) //这个转成序号

		console.log("strLedger.length", strLedger.length, "seqEnd", seqEnd)
		let hcount = lapi.Hset(mmsidnode, tpLedger, seqEnd, strLedger)
		
		//设置最后序号
		lapi.Hset(mmsidnode, tpLedger, "last", seqEnd)

		console.log("ledger2Db hset", tpLedger, "Receiver", ledger.Receiver, "seqEnd", seqEnd, "hcount=", hcount)

		return seqEnd
	}
	

	//这是新的账单读取，加了seq
	//这是读取离续号最近的账单信息
	function getStrLedger(mmsid, hkey, seqLedger){
		if (!Number.isFinite(seqLedger)){
			// console.log("getStrLedger seqLedger is not finite")
			throw new Error("getStrLedger seqLedger is not a number")
		}

		// console.log("getStrLedger hkey", hkey, seqLedger)
	
		// console.log("getStrLedger")
		try{
			let strSeq
			if (seqLedger < 0) {
				 strSeq = lapi.Hget(mmsid, hkey, "last")	
				 if (isEmpty(strSeq)) {
					seqLedger = Number.MAX_SAFE_INTEGER
				 } else {
					seqLedger = parseInt(strSeq, 10)
				 }
			}

			//再转换成字符串
			strSeq = seqLedger.toString()
			// console.log("getStrLedger strSeq=", strSeq)

			//直接读取
			//这里留意会不会发生异常
			let strLedger = lapi.Hget(mmsid, hkey, strSeq)
			if (has(strLedger)) {
				// console.log("getStrLedger strSeq=", strSeq)
				return [seqLedger, strLedger]
			}

			//读取所有的key值
			let keys = lapi.Hkeys(mmsid, hkey)
			// console.log("getStrLedger keys=", keys)
			
			//轮询
			let seqLast = 0
			for (let i = 0; i < keys.length; i++) {
				let key = keys[i]
				let seqKey = parseInt(key, 10)
				// console.log("getStrLedger parseInt key=", key, "seqKey=", seqKey)

				if (isNaN(seqKey) || seqKey > seqLedger || seqKey < seqLast) {
					continue
				}

				seqLast = seqKey
				// console.log("getStrLedger seqLast=seqKey=", seqLast)

			}
			
			// console.log("getStrLedger seqLast=", seqLast)
			if (seqLast == 0){
				// console.log("getStrLedger seqLast = 0 return empty")
				return [0, ""]
			}

			strSeq = seqLast.toString()
			strLedger = lapi.Hget(mmsid, hkey, strSeq)
			if (isEmpty(strLedger)) {
				return [0, ""]
			}

			// console.log("getStrLedger return seqLast + 1", seqLast + 1)
			return [seqLast, strLedger]
		}catch(e){			
			console.log("getStrLedger 发现异常，需要重点关注 error", e, seq)
		}
	
		//返回一个空的汇总信息，不能是｛｝，解析的时候没有签名过不去
		// console.log("getStrLedger return empty signinfo")
		return [0, ""]
	}


	function getNumberFromMap(mapLedger, key){
		return Number(mapLedger?.[key] ?? 0)
	}


	function getFriendByAppCode(nodeAppCode) {
		if (!nodeAppCode) {
			throw new Error("nodeAppCode is required")
		}
		console.log("nodeAppCode=", nodeAppCode)

		const fri = lapi.SessionGet(nodeAppCode, "nodeid")
		const forapp = lapi.SessionGet(nodeAppCode, "forapp")
		console.log("forapp=", forapp)
		console.log("appid=", appid)

		if (appid !== forapp) {
			throw new Error(`App ID mismatch: expected ${appid}, got ${forapp}`)
		}

		return fri
	}

	function args2Params(args) {
		// 参数验证
		if (!Array.isArray(args) || args.length < 2) {
			throw new Error("Invalid arguments: expected array with at least 2 elements")
		}

		const [tp, fri] = args
		console.log("setledger tp=", tp, " fri=", fri)

		const wanted = []
		const unwanted = []
		let currentArray = wanted

		// 处理从索引2开始的区块信息
		for (let i = 2; i < args.length; i++) {
			const blockInfo = args[i]

			// 切换到 unwanted 数组
			if (blockInfo === null) {
				currentArray = unwanted
				continue
			}

			// 验证区块信息
			if (!isValidBlockInfo(blockInfo)) {
				console.log("Invalid block info:", blockInfo)
				continue
			}

			currentArray.push(blockInfo)
		}

		return [tp, fri, wanted, unwanted]
	}

	// 辅助函数：验证区块信息
	function isValidBlockInfo(blockInfo) {
		if (!blockInfo || !blockInfo.Cid) {
			console.log("Missing Cid in blockInfo:", blockInfo)
			return false
		}

		const size = blockInfo.Size
		if (typeof size !== 'number' || !Number.isFinite(size)) {
			console.log("Invalid Size in blockInfo:", blockInfo)
			return false
		}

		return true
	}

	function ZAddBlocks(mmsid, tpBlockInfo, blocks){
		if (blocks == null || blocks.length == 0){
			return 0
		}
		let members = []
		for (i=0; i<blocks.length; i++){
			let blockinfo = blocks[i]
			let cid = blockinfo.Cid
			let size = blockinfo.Size
			let strSize =  size.toString(16)
			let member =  cid + ";"+ strSize
			members.push(member)
		}
		return  lapi.Zaddwithseq(mmsid, tpBlockInfo, ...members)
	}

	function updatedb(mmsidnode, fri, sid) {
		//数据方式读出
//		let nLastSeqSelfSent = Number(lapi.Hget(mmsidnode, KeyAppInfo, FieldLastSeqCheck))
		//字符串方式读出
		let strLastSeqSelfSent = lapi.Hget(mmsidnode, KeyAppInfo, FieldLastSeqCheck)
		if (has(strLastSeqSelfSent)) {
			console.log("updatedb strLastSeqSelfSent=", strLastSeqSelfSent, "skip")
			return Number(strLastSeqSelfSent)
		}

		let curDbSeq = lapi.GetLastSeq(mmsidnode)
		console.log("updatedb mmsidnode=", mmsidnode, strLastSeqSelfSent, curDbSeq)

		let mmsidself = openLedger(sid, fri)
		console.log("updatedb mmsidself=", mmsidself)

		let updateLogDb = (selfKey, nodeKey) => {
			//能进这里，需要先数据清理
			let nRet = lapi.Zclear(mmsidnode, nodeKey)
			console.log("zclear KeyLogSent nRet=", nRet)
	
	
			let sps = lapi.Zrangebyscore(mmsidself, selfKey, 0, Number.MAX_SAFE_INTEGER, 0, -1)
			console.log("updatedb sps.length=", sps.length)
			
			//写入新数据库
			for (let i=0; i<sps.length; i++) {
				lapi.Zaddwithseq(mmsidnode, nodeKey, sps[i].Member)
				// console.log("updatedb sps[i].Member=", sps[i].Member, "nret", nret)
			}	
		}

		let selfKey = KeyLogSent
		let nodeKey = KeyLogSent + fri

		updateLogDb(selfKey, nodeKey)

		selfKey = KeyLogReceived
		nodeKey = KeyLogRecv3 + fri

		updateLogDb(selfKey, nodeKey)

		lapi.MMClose(mmsidself)	

		lapi.Hset(mmsidnode, KeyAppInfo, FieldLastSeqCheck, curDbSeq)

		return curDbSeq
	}

	function SumBlockInfo(mmsidnode, fri, strWantCheck, nLastSeqSelfSent){
		console.log("SumBlockInfo", mmsidnode, fri, strWantCheck, nLastSeqSelfSent)
		if (isNaN(nLastSeqSelfSent)){
			let strLastSeqSelfSent = lapi.Hget(mmsidnode, KeyAppInfo, FieldLastSeqCheck)
			if (has(strLastSeqSelfSent)){
				nLastSeqSelfSent = Number(strLastSeqSelfSent)
			} else {
				nLastSeqSelfSent = -1
			}
		}

		//读取最后序号
		let curDbSeq = lapi.GetLastSeq(mmsidnode)
		console.log("SumBlockInfo curDbSeq=", curDbSeq)

		let wantCheck = function(){			
			//跳过条件检查
			if (strWantCheck == "true"){
				return true
			}

			let tmLastCheck= Number(lapi.Hget(mmsidnode, KeyAppInfo, FieldCheckTime))
			// console.log("tmCheck=", tmLastCheck)
			var tmCur = Date.now();
			var tmDiff = tmCur - tmLastCheck
			// console.log("tmDiff=", tmDiff)

			//刚检查过不检查
			if (tmDiff < 60 * 1000){
				return false
			}

			//判断是否需要检查
			//这里会有-1的情况
			if (curDbSeq - nLastSeqSelfSent > 40){
				console.log("curDbSeq - nLastSeqSelfSent > 40", curDbSeq, nLastSeqSelfSent)

				lapi.Hset(mmsidnode, KeyAppInfo, FieldCheckTime, tmCur)
				return true
			}
			
			if (tmDiff > 60 * 60 * 1000){
				console.log("tmDiff > 60 * 60 * 1000", tmDiff)

				lapi.Hset(mmsidnode, KeyAppInfo, FieldCheckTime, tmCur)

				return true
			}					

			return false
		}
		
		if (!wantCheck()){
		    return 
		}

		if (doCheck3(mmsidnode, fri, nLastSeqSelfSent, curDbSeq)){
			//tmLastCheck
			//FieldLastSeqCheck已经不使用了，观察一下后续去除。250213
			//重新恢复使用了，只是标识了一下新旧数据库
			lapi.Hset(mmsidnode, KeyAppInfo, FieldLastSeqCheck, curDbSeq)
		}

		return //true
	}

	function setBlockInfo(){
		console.log("setBlockInfo")
	
		let [tpBlockInfo, fri, wanted, unwanted] = args2Params(args)
	
		if (fri == null || fri.length < 27){
			console.log("setBlockInfo bad fri =", fri)
			return
		}
		console.log("args2Params ok unwanted", unwanted, "tpBlockInfo=", tpBlockInfo)
		
		let mmsidnode = openLedgerNode()
		// console.log("mmsidnode=", mmsidnode)

		//加入数据库升级，数据从旧数据库复制到新数据库中
		let nLastSeqSelfSent = updatedb(mmsidnode, fri, request.sid)

		if (tpBlockInfo == KeyLogReceived){
			tpBlockInfo  = KeyLogRecv3
		}

		let keytpBlockInfo = tpBlockInfo + fri
		//wanted
		ret = ZAddBlocks(mmsidnode, keytpBlockInfo, wanted)
		console.log("writeLedger ZAddBlocks wanted ok ret=", ret, "tpBlockInfo=", tpBlockInfo)

		//unwanted
		ret += ZAddBlocks(mmsidnode, keytpBlockInfo, unwanted)
		console.log("writeLedger ZAddBlocks unwanted ok ret=", ret, "tpBlockInfo=", tpBlockInfo)
	
		if (tpBlockInfo == KeyLogSent){
			SumBlockInfo(mmsidnode, fri, "false", nLastSeqSelfSent)
// 			checkLedgerWithSid(mmsidnode, mmsiduser, fri, "", -1)
		} else {
			//console.log("不应该触发检查的, tpBlockInfo=", tpBlockInfo)
		}
				
		lapi.MMClose(mmsidnode)

		return ret
	}

	//
	function getSentInfo3(mmsidnode, friendid, nLastSeqSelfSent, curSeqSelfSent) {
		let [seqSign, mapLastSum] = getLedgerMap3(mmsidnode, HKeySelfSum3+friendid, nLastSeqSelfSent)
		console.log("getSentInfo3 seqSign=", seqSign, "mapLastSum=", mapLastSum)

		//有新的获取代码了
		let [lastSeq, lastTotalCount, lastTotalSize] = getSumInfoFromMap3(KeyLogSent, mapLastSum)
		console.log("getSentInfo3 lastTotalSize=", lastTotalSize, "lastTotalCount=", lastTotalCount, lastSeq)

		//这里读的是发送log
		let seqStart = seqSign + 1
		console.log("getSentInfo3 seqStart=", seqStart, "curSeqSelfSent=", curSeqSelfSent)

		let sps = lapi.Zrangebyscore(mmsidnode, KeyLogSent+friendid, seqStart, curSeqSelfSent, 0, -1)
		console.log("getSentInfo3 sps.length=", sps.length)		
				
		//统计size
		let totalSize = 0
		let totalCount = sps.length
		for (let i = 0;i < totalCount;i++){
			let sp = sps[i] 
			let member = String(sp.Member)
			let blockSize = parseSizeFromMember(member)
			// console.log("sp ",sp.Score, member, blockSize)
			totalSize += blockSize
		}

		let endSeq = nLastSeqSelfSent 
		//这个endseq在这里作用并不大
		if (totalCount > 0){
			console.log("lastSeq", sps[totalCount-1].Score)
			endSeq = sps[totalCount-1].Score
		} 
		
		console.log("getSentInfo totalSize=", totalSize, "totalCount", sps.length, endSeq)
		
		let curTotalCount = totalCount + lastTotalCount
		console.log("getSentInfo curTotalCount=", curTotalCount, totalCount, lastTotalCount)

		let curTotalSize = totalSize + lastTotalSize

		console.log("getSentInfo curTotalSize=", curTotalSize, totalSize, lastTotalSize)

		let SeqReceiver = (mapLastSum.SeqReceiver == null) ? 0 : Number(mapLastSum.SeqReceiver)
		return [seqSign, curTotalCount, curTotalSize, SeqReceiver]
	}
	
	function getTotalSumInfo3(curSumRecv, key){
		if (isEmpty(curSumRecv)) {
			return [0, 0, 0, 0, 0]
		}

		// let mapSumCur = {}
		let mapSumCur = lapi.SignInfo2Map(curSumRecv)		
		let count = getNumberFromMap(mapSumCur, "Count")
		console.log("getTotalSumInfo3 count=", count)

		let size = getNumberFromMap(mapSumCur, "Size")
		console.log("getTotalSumInfo3 size=", size)

		let keyCount = key + KeyTotalCount3
		let keySize = key + KeyTotalSize3

		let totalCount = getNumberFromMap(mapSumCur, keyCount)
		console.log("getTotalSumInfo3 totalCount=", totalCount)

		let totalSize = getNumberFromMap(mapSumCur, keySize)
		console.log("getTotalSumInfo3 totalSize=", totalSize)

		let seqEnd = getNumberFromMap(mapSumCur, "SeqEnd")

		return [seqEnd, count, size, totalCount, totalSize]
	}

	function getRecvInfo3(mmsidnode, friendid, lastSeqFriRecv) {
		console.log("getRecvInfo3 friendid=", friendid, "lastSeqFriRecv=", lastSeqFriRecv)

		//读取好友
		let req = {}
		req.aid = appid
		req.ver = request.ver
		req.nid = friendid
		req.sid= request.sid		
		req.tp = "getzledger3"		

		let reqArgs = []

		if (lastSeqFriRecv != null) {
			//旧的序号方式
			//读取上次保存的最后序号
			req.seqpre = lastSeqFriRecv
			reqArgs.push(null)
		}else{
			//读取本地的保存
			console.log("getRecvInfo3 getStrLedger")
			let [lastRecvSeq, lastRecvLedger] = getStrLedger(mmsidnode, HKeyFriRecv3+friendid, curSumRecv)
			console.log("lastRecvSeq=", lastRecvSeq, "lastRecvLedger=", lastRecvLedger)
			reqArgs.push(lastRecvLedger)
		}

		console.log("getRecvInfo3 2")
				
		console.log("lapi.RunMApp ledger friendid=", friendid, "seq", lastSeqFriRecv)
		let blocks = lapi.RunMApp("ledger", req, reqArgs)

		//第一个是上次的数据汇总
		//最后一个是当前的汇总数据
		//中间是最新的数据
		if (blocks == null || blocks.length < 2){
			//没有数据表示好友没有数据，不需处理，直接返回
			console.log("lapi.RunMApp ledger friendid=", friendid, "blocks is null blocks=", blocks)
			return [0, 0, 0, null]
		}
	
		console.log("lapi.RunMApp ledger friendid=", friendid, "blocks.length=", blocks.length)

		let lastSumRecv = blocks[0]
		console.log("lastSumRecv", lastSumRecv)

		let [lastSeqEnd, lastTotalCount, lastTotalSize] = getSumTotal(lastSumRecv, KeyLogRecv3)
		console.log("getRecvInfo3 lastTotalSize=", lastTotalSize, "lastTotalCount=", lastTotalCount, "lastSeqEnd=", lastSeqEnd)

		let curSumRecv = blocks[blocks.length - 1]

		console.log("curSumRecv", curSumRecv)

		// let [seqEnd, curTotalCount, curTotalSize] = getSumTotal(curSumRecv, KeyLogRecv3)
		// console.log("getRecvInfo3 curTotalSize=", curTotalSize, "curTotalCount=", curTotalCount, "seqEnd=", seqEnd)

		// console.log("getRecvInfo3， 这里还少一个数据验证的环节，后续添加")
		
		// console.log("getRecvInfo3， 这里还少一个数据验证的环节，代码已添加，还没有严格测试 ")

		let [seqEnd, recvCount, recvSize, curTotalCount, curTotalSize] =  getTotalSumInfo3(curSumRecv, KeyLogRecv3)

		//数据核对
		//统计size
		let totalSize = 0
		let totalCount = blocks.length - 2
		for (let i = 1; i < blocks.length - 1; i++) {
			let m = blocks[i]
			let blockSize = parseSizeFromMember(m)
			totalSize += blockSize
		}

		console.log("cal totalSize=", totalSize)
		console.log("cal totalCount=", totalCount)

		//核查数据
		if (totalSize != recvSize || totalCount != recvCount){
			throw new Error("recvSize or recvCount is not match", recvSize, recvCount)
		}

		if (lastTotalCount + recvCount != curTotalCount){
			throw new Error("curTotalCount is not match", lastTotalCount + recvCount, curTotalCount)
		}

		if (lastTotalSize + recvSize != curTotalSize) {
			throw new Error("curTotalSize is not match", lastTotalSize + recvSize, curTotalSize)
		}


		return [seqEnd, curTotalCount, curTotalSize, curSumRecv]		
	}

	//检查好友返回的ledger
	function doCheck3(mmsidnode,  friendid, nLastSeqSelfSent, seqrequester, lastSeqFriRecv){
		let selfid = lapi.GetVar("", "hostid")

		console.log("doCheck3 begin", mmsidnode, "selfid=", selfid)

		//先读取本地
		//这里暂时都用mmsidnode
		let [seqSign, sentTotalCount, sentTotalSize, SeqReceiver] = getSentInfo3(mmsidnode, friendid, nLastSeqSelfSent, seqrequester)
		console.log("doCheck3 getSentInfo", seqSign, sentTotalCount, sentTotalSize, SeqReceiver)

		if (lastSeqFriRecv == null || lastSeqFriRecv < 0){
			console.log("doCheck3 SeqReceiver=", SeqReceiver)
			lastSeqFriRecv = SeqReceiver
		}

		console.log("doCheck3 lastSeqFriRecv=", lastSeqFriRecv)

		// //取好友的接收信息
		let [recvSeqEnd, recvTotalCount, recvTotalSize,  curSumRecv] = getRecvInfo3(mmsidnode, friendid, lastSeqFriRecv) 
		console.log("doCheck3 recvSeqEnd=", recvSeqEnd, "recvTotalCount=", recvTotalCount, "recvTotalSize=", recvTotalSize, curSumRecv)

		//之前曾经是空，这里直接抛异常
		if (recvTotalSize == null){
			throw new Error("recvTotalSize is null")
		}

		//生成汇总信息
		let siSummary = {}
	
		//发送者和接收者
		siSummary.Sender = selfid 
		siSummary.Receiver = friendid
		
		//发送者序号和接收者序号
		siSummary.sentSeqEnd = seqrequester //发送者的序号
		siSummary.recvSeqEnd = recvSeqEnd	//接收者的序号
		siSummary.SeqEnd = seqrequester//这里应该用签发者的序号

		siSummary.recvTotalCount = recvTotalCount
		siSummary.recvTotalSize = recvTotalSize

		siSummary.sentTotalCount = sentTotalCount
		siSummary.sentTotalSize = sentTotalSize

		sumInfoSignAndSave3(mmsidnode, siSummary, friendid, curSumRecv, seqrequester)

		return true 
	}


	//这是上次记录的点
	//解析汇总信息
	function getSumTotal(strLedger, key){
		console.log("getSumTotal", strLedger, key)

		if (strLedger == null || strLedger == ""){
		    return [0, 0, 0]
		}

		console.log("getSumTotal 1", strLedger)

		let ledgerLast = lapi.SignInfo2Map(strLedger)
			
		console.log("getSumTotal 2", key, ledgerLast)

		return getSumInfoFromMap3(key, ledgerLast)
	}
	
	//收发两种情况
	function getSumInfoFromMap3(key, mapLedger){
		let keyCount = key + KeyTotalCount3
		let keySize = key + KeyTotalSize3

		if (mapLedger[keyCount] == null || mapLedger[keySize] == null){
			console.log("getSumInfoFromMap3", keyCount, keySize, mapLedger[keyCount], mapLedger[keySize])
			return [0, 0, 0]
		}

		let seqEnd = Number(mapLedger.SeqEnd)  
		let count = Number(mapLedger[keyCount])
		let size = Number(mapLedger[keySize])
		console.log("getSumInfoFromMap3", count, size)
		if (isNaN(seqEnd) || isNaN(count) || isNaN(size)){
			throw new Error("bad seqEnd or count or size", seqEnd, count, size)
		}

		return [seqEnd, count, size]
	}

	//近回最近的能行证和之后未对账的信息
	function getLedgerFromDb3(mmsidnode, selfid, fri, key, lastCheckSeq){
		console.log("getLedgerFromDb3", mmsidnode, selfid, fri, key, lastCheckSeq)

		let ledgerKey
		if (key == KeyLogSent){
		    ledgerKey = HKeySelfSum3 + fri
		} else if (key == KeyLogRecv3) {
		    ledgerKey = HKeyFriSumm3 + fri
		} else {
			throw new Error("bad key:[" + key + "]")
		}

		let ret = []

		let nLastCheckSeq  = Number(lastCheckSeq)
		if (isNaN(nLastCheckSeq)){
			nLastCheckSeq = -1 //缺省值
		}

		console.log("nLastCheckSeq=", nLastCheckSeq)
	
		//这里返回的是上次汇总的序号和汇总信息
		let [seqSum, strLedger] = getStrLedger(mmsidnode, ledgerKey, nLastCheckSeq)
		//console.log("getLedgerFromDb3 seqSum=", seqSum, "strLedger=", strLedger)

		//处理序号
		//如果起始值不对，要以seqSum为准
		if (seqSum != nLastCheckSeq) {
			//console.log("getLedgerFromDb3 seqSum != nLastCheckSeq", seqSum, nLastCheckSeq)
			//确保seqSum == nLastCheckSeq
			nLastCheckSeq = seqSum   
		}

		//加入第一项
		ret.push(strLedger)

		//console.log("getLedgerFromDb3 strLedger=", strLedger)
				
		let [lastSeq, lastTotalCount, lastTotalSize] = getSumTotal(strLedger, key)
		//console.log("sum", lastTotalSize, lastTotalCount, lastSeq)

		let ledger = {}
		if (key == KeyLogSent){
			ledger.Sender = selfid 
			ledger.Receiver = fri
		} else {
			ledger.Sender = fri
			ledger.Receiver =  selfid
		} 

		ledger.LedgerType = key
		
		let beginSeq =  nLastCheckSeq + 1
		//console.log("getLedgerFromDb3 beginSeq=", beginSeq, "lastcheckseq=", nLastCheckSeq)

		let endSeq =lapi.GetLastSeq(mmsidnode)
		//console.log("getLedgerFromDb3 endSeq=", endSeq)

		let sps = lapi.Zrangebyscore(mmsidnode, key + fri, beginSeq, endSeq, 0, -1)
		//console.log("getLedgerFromDb3 sps=", sps.length)
		 		
		//统计size
		let totalSize = 0
		let totalCount = sps.length
		for (let i = 0;i < totalCount;i++){
			let sp = sps[i] 
			let member = String(sp.Member)
			let blockSize = parseSizeFromMember(member)
			// console.log("sp ",sp.Score, member, blockSize)
			totalSize += blockSize
			ret.push(member)
		}
		
		if (totalCount > 0){
			//console.log("getLedgerFromDb3 lastSeq", sps[totalCount-1].Score)
			endSeq = sps[totalCount-1].Score
		} else{
			endSeq = beginSeq - 1 //通常是上次加1，这里减1，表示没有数据
		}
		
		console.log("getLedgerFromDb3 totalSize=", totalSize, "totalCount", sps.length)

		//起始序号，指上一次操作的序号，这里使用缺省值
		ledger.SeqStart = beginSeq
		ledger.SeqEnd = endSeq

		ledger.Size = totalSize
		ledger.Count = totalCount


		ledger[key + KeyTotalCount3] = totalCount + lastTotalCount
		ledger[key + KeyTotalSize3] = totalSize + lastTotalSize
		
		strLedger = lapi.BESign(ledger) //新的签名机制
		// console.log("getLedgerFromDb3 BESign strLedger.length", strLedger.length)
		// console.log("getLedgerFromDb3 BESign strLedger=", strLedger)

		//小结，加在了Ret的最后
		ret.push(strLedger)

		return ret
	}
	
	function getZLedger3(nodeAppCode, keylog, seqpre){
		if (isEmpty(keylog)){
			keylog = KeyLogRecv3
		}

		console.log("getZLedger seqpre=", seqpre, "keylog=", keylog)
		if (seqpre == undefined) {
			seqpre = 0
		}

		let fri = getFriendByAppCode(nodeAppCode)
		
		let mmsidnode = openLedgerNode()

		let selfid = lapi.GetVar("", "hostid")
		let ret = getLedgerFromDb3(mmsidnode, selfid, fri, keylog, seqpre)

		lapi.MMClose(mmsidnode)

		return ret
	}

	function getLedgerMap3(mmsidnode, ledgerKey, seqSummary){
		try{			
			let [seqsign, strLedger] = getStrLedger(mmsidnode, ledgerKey, seqSummary)
			if (strLedger == ""){
				return [0, {}]
			}

			console.log("getLastLedgerMap3 strLedger=", strLedger)
			//解析通行证
			let ledger = lapi.SignInfo2Map(strLedger)
			// console.log("ledger=", ledger)
	
			return [seqsign, ledger]	
		}catch(e){
		// 	console.log("catch error", e)
		}

		//返回一个空的通行证
		console.log("return empty ppt")
		return [0, {}]
	}

	function checkLedger3(fri, strWantCheck, strLastSeqSelfSent, lastSeqFriRecv){
		if (isEmpty(fri)){
			throw new Error("fri is empty")
		}

		console.log("checkLedger3 fri=", fri, "strLastSeqSelfSent=", strLastSeqSelfSent, "lastSeqFriRecv=", lastSeqFriRecv)

		let mmsidnode = openLedgerNode()
		SumBlockInfo(mmsidnode, fri, strWantCheck, Number(strLastSeqSelfSent), lastSeqFriRecv)
		lapi.MMClose(mmsidnode)

		return "checkLedger3 ok"
	}

	//这部分数据应该放入节点数据
	//sumsid中有之前保存的当前节点前收时的汇总信息
	function setsuminfo3(args){
		if (args.length < 2){
			throw new Error("savesuminfo3 args length < 1");
		}

		let strsuminfo = args[0]
		console.log("setsuminfo3 strsuminfo=", strsuminfo)

		let	strRecvInfo = args[1]

		console.log("setsuminfo strRecvInfo=", strRecvInfo)

		let nodeAppCode = request.nodeappcode
		let friendid = getFriendByAppCode(nodeAppCode)
		console.log("setsuminfo3 friendid=", friendid)

		//打开节点应用数据区
		let mmsidnode = openLedgerNode()
		// console.log("setsuminfo3 mmsidnode=", mmsidnode)

		//check
		checkSumInfo = (mapSumInfo) => {
			console.log("mapSumInfo.recvTotalCount=", mapSumInfo.recvTotalCount)
			console.log("mapSumInfo.recvTotalSize=", mapSumInfo.recvTotalSize)
			console.log("mapSumInfo.recvSeqEnd=", mapSumInfo.recvSeqEnd)

			//处理空情况
			if (isEmpty(strRecvInfo)){
				return false
			}

			//解析
			let mapRecv = lapi.SignInfo2Map(strRecvInfo)
			//对比信息
			console.log("mapRecv.recvTotalCount=", mapRecv.recvTotalCount)
			console.log("mapRecv.recvTotalSize=", mapRecv.recvTotalSize)
			console.log("mapRecv.SeqEnd=", mapRecv.SeqEnd)
	
			//返回结果
			if (mapRecv.SeqEnd != mapSumInfo.recvSeqEnd) {
				return false
			}

			if (mapRecv.recvTotalCount != mapSumInfo.recvTotalCount) {
				return false
			}

			if (mapRecv.recvTotalSize != mapSumInfo.recvTotalSize) {
				return false
			}

			console.log("checkSumInfo ok")
			
			//可以保存自己的通行证了
			// let key = HKeySelfRecv + friendid
			let seqend = ledger2Db(mmsidnode, HKeySelfRecv + friendid, strRecvInfo, null)
			console.log("setsuminfo saveselfrecv seqend=", seqend)

			return true
		}

		// let hkey = HKeyFriSummary
		let seqend = ledger2Db(mmsidnode, HKeyFriSumm3 + friendid, strsuminfo, checkSumInfo)
		console.log("setsuminfo seqend=", seqend)
		
		lapi.MMClose(mmsidnode)
		return seqend
	}

	function sumInfoSignAndSave3(mmsidnode, siSummary, friendid, curSumRecv, seqrequester){
		console.log("sumInfoSignAndSave3 curSumRecv=", curSumRecv)

		//双方数据合并
		let strledger = lapi.BESign(siSummary) //新的签名机制
		console.log("sumInfoSignAndSave3 BESign strLedger.length", strledger.length)

		req = {} //清理之前变量上的值
		req.aid = appid
		req.ver = request.ver
		req.nid = friendid
		req.sid= request.sid		//这个sid是本地的，对远方节点是无效的
		req.tp = "setsuminfo3"		

		var args = [strledger, curSumRecv]

		console.log("sumInfoSignAndSave3 lapi.RunMApp ledger setsuminfo friendid=", friendid)
		let ret = lapi.RunMApp("ledger", req, args)
		console.log("sumInfoSignAndSave3 RunMApp ledger ret=", ret)

		//这应该是序号，可以对比一下
		if (ret != seqrequester){
			// throw new Error("ret != seqrequester");
			console.log("sumInfoSignAndSave3 ret != seqrequester", ret, seqrequester)
			return false
		}

		//本地保存
		//整个mmsid是有问题的，应该转为应用部分
		ledger2Db(mmsidnode, HKeySelfSum3 + friendid, strledger, null)
		ledger2Db(mmsidnode, HKeyFriRecv3 + friendid, curSumRecv, null)
		console.log("setLedger ok")		 
	}
	function clearLedger(sid){
		console.log("clearLedger sid=", sid)
	}

	function showDb(sid, fri, key) {
		console.log("showDb sid=", sid, "fri=", fri, "key=", key)
		
		if (isEmpty(key)) {
			// 列出所有可能的hash table类型的key值供参考
			throw new Error("key parameter is required. Possible values: 'selfsum', 'frisum', 'selfrecv', 'frirecv'")
		}
		
		let mmsidnode = openLedgerNode()
		let mmsidnode2 = mmsidnode
		console.log("showDb openLedgerNode typeof mmsidnode", typeof mmsidnode, typeof mmsidnode2)

		try {
			let result = []
			console.log("showDb Hgetall key=", key + fri)
			let data = lapi.Hgetall(mmsidnode2, key + fri)
			if (data) {
				console.log("request set")
				data.forEach(pair => {
					console.log("pair.Field=", pair.Field)
					result.push(pair.Field)
				})
				console.log("request set ok")
			}
			console.log("return ok")
			return result
			
		} catch(e) {
			console.log("showDb error:", e)
			throw new Error("Failed to show database: " + e.message)
		} finally {
			console.log("showDb finally close mmsidnode2", mmsidnode2)
			lapi.MMClose(mmsidnode2)
			console.log("showDb finally close ok")
		}
		return []
	}

try{	
	//读出show
	let tp = request.tp
	console.log("tp=", tp)
	
	switch(tp){
	//以下新入口
	case "set":
	case "setblockinfo":
		//这个是新版的set,用于替换set
		return setBlockInfo()	
	
	case "updatedb": {
		//这个是用于测试updatedb的，任务基本完成了
		//还差清空汇总信息
		console.log("updatedb fri=", request.fri)
		let mmsidnode = openLedgerNode()
		updatedb(mmsidnode, request.fri, request.sid)
		lapi.MMClose(mmsidnode)
		return "updatedb ok"
	}	

	case "sumblockinfo":{
		//测试SumBlockInfo, 用于替换checkLedgerWithSid
		let mmsidnode = openLedgerNode()
		// console.log("mmsidnode=", mmsidnode)
	
		let nLastseqselfsent = Number(request.lastseqselfsent)

		SumBlockInfo(mmsidnode, request.fri, request.wantcheck, nLastseqselfsent)
	
		lapi.MMClose(mmsidnode)
	
		return "test SumBlockInfo end"	
	}

	case "getledger3":{
		//升级数据库
		let mmsidnode = openLedgerNode()
		updatedb(mmsidnode, request.fri, request.sid)

		let selfid = lapi.GetVar("", "hostid")
		console.log("getledger3", selfid, request.fri, request.tplog, request.lastseq, mmsidnode)

		let ret = getLedgerFromDb3(mmsidnode, selfid, request.fri, request.tplog, request.lastseq)
	
		lapi.MMClose(mmsidnode)

		return ret
	}
	
	case "getzledger3":
		return getZLedger3(request.nodeappcode, request.key, request.seqpre)
	
		
	case "checkLedger3":
		//测试命令：Leither lpki runapp 9QHDgCSdxWYPFyd4XxJz7DQasam ledger -r "tp=checkLedger3&fri=pRbWL18Byndrt876tyBiySLE99w&wantcheck=true&lastseqselfsent=-1&tplog=sent" -v  last
		//用于测试旧的check流程
		console.log("check  lastseqfrirecv=",  request.lastseqfrirecv)
		return checkLedger3(request.fri, request.wantcheck, request.lastseqselfsent, request.lastseqfrirecv)
	
	case "setsuminfo3":
		//设置汇总信息，用于回传，目前这是旧流程
		return setsuminfo3(args)

	case "show":
		return creditShow2(request.sid, request.pid)

	case "zcount":
		return getLedgerZCount()

	case "clear":
		return clearLedger(request.sid)
		
	case "showdb":
		//测试命令：Leither lpki runapp 9QHDgCSdxWYPFyd4XxJz7DQasam ledger -r "tp=showdb&sid=1234567890&fri=pRbWL18Byndrt876tyBiySLE99w&key=sent" -v  last
		return showDb(request.sid, request.fri, request.key)
		
	case "":
	case undefined:
		return "Deprecated tp:" + tp
		
	//出上为新入口		
	//以下旧入口


	//当前系统使用的是这个，暂时保留，后续替换	
	// case "set":
	// 	return setLedger(request.sid)
	
	// case "setsuminfo":
	// 	//设置汇总信息，用于回传，目前这是旧流程
	// 	return setsuminfo(request.sumsid, args)
	

	//以下为不用的接口
	case "getsummary":
		//暂时屏蔽了
		console.log("getsummary不再使用准备移除")
		// return getLedgerSummary(request.sid, request.pid, request.tpledger)

	//测试用，后续去除
	case "getledger":
		console.log("getledger不再使用准备移除")

		
	case "getzledger":
		console.log("getzledger 不再使用准备移除")

		// return getZLedger(request.nodeappcode, request.key, request.seqpre, request.wantsid)
		
	case "setppt":
		console.log("set ppt 这里应该进不来了，不再使用准备移除")

	case "check":
		//用于测试旧的check流程
		console.log("这个应该进不来了，后续移除， check  lastseqfrirecv=",  request.lastseqfrirecv)
		// return checkLedger(request.sid, request.fri, request.wantcheck, request.lastseqselfsent, request.lastseqfrirecv)

	}

	console.log("tp=", tp, "not found")
	return "Deprecated tp:" + tp
}catch(e){
	console.log("catch error", e)
    throw e
}

})(request, args)
// console.log("end of ledger.js")