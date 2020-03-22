// ==UserScript==
// @name         E-HENTAI-VIEW-ENHANCE
// @namespace    https://github.com/kamo2020/eh-view-enhance
// @version      1.0.2
// @description  强化E绅士看图体验
// @author       kamo2020
// @match        https://exhentai.org/g/*
// @match        https://e-hentai.org/g/*
// @icon         https://exhentai.org/favicon.ico
// ==/UserScript==

//==================面向对象，图片获取器IMGFetcher，图片获取器调用队列IMGFetcherQueue=====================START
class IMGFetcher {
    constructor(node) {
        this.node = node;
        this.url = node.getAttribute("ahref");
        this.oldSrc = node.src;
        //当前处理阶段，0: 什么也没做 1: 获取到大图地址 2: 完整的获取到大图
        this.stage = 0;
        this.tryTime = 0;
        this.lock = false;
    }

    async fetchImg(x) {
        switch (this.stage) {
            case 0://尝试获取大图地址
                try {
                    //给当前缩略图元素添加一个获取中的边框样式
                    this.node.classList.add("fetching");
                    //使用fetch获取该缩略图所指向的大图页面
                    const response = await window.fetch(this.url);
                    const text = await response.text();
                    //从大图页面中提取大图的地址，todo 之后会加入重试换源的功能
                    this.bigImageUrl = IMGFetcher.extractBigImgUrl.exec(text)[1];
                    //成功获取到大图的地址后，将本图片获取器的状态修改为1，表示大图地址已经成功获取到
                    if (this.bigImageUrl) {
                        this.stage = 1;
                        return/* 少写一个return，花了我4小时调试一个奇怪的bug */ this.fetchImg(x);
                    } else {
                        throw "大图地址不存在！";
                    }
                } catch (error) {
                    this.stage = 0;//如果失败后，则将图片获取器的状态修改为0，表示从0开始
                    console.log("获取大图地址的时候出现了异常 => ", error);
                    return false;
                }
            case 1://理论上获取到大图地址，尝试使用weirdFetch获取大图数据
                try {
                    //使用奇怪的图片获取器来获取大图的数据
                    const flag = await IMGFetcher.weirdFetch(this.node, this.bigImageUrl, this.oldSrc).then(result => result.flag);
                    //当获取到内容，或者获取失败，则移除本缩略图的边框效果
                    this.node.classList.remove("fetching");
                    if (flag) {//如果成功获取到图片的内容，则将本图片获取器的状态修改为2，表示图片获取器的整体成功
                        this.stage = 2; this.node.style.border = "3px #602a5c solid"; return this.fetchImg(x);
                    } else {//如果失败了，则进行重试，重试会进行2次
                        ++this.tryTime; this.stage = 0; this.node.style.border = "3px white solid";
                        if (this.tryTime > 2) { this.node.style.border = "3px red solid"; return false; }//重试2次后，直接失败，避免无限请求
                        return this.fetchImg(x);
                    }
                } catch (error) {
                    this.stage = 1;
                    console.log("在获取大图数据的时候出现了错误，一般来说不会出现这样的错误 => ", error);
                    return false;
                }
            case 2://大图已经加载完毕，已经走到这个IMGFetcher图片获取器的生命尽头，以后调用这个IMGFetcher图片获取器的时候，直接返回确认
                return true;
        }
    }

    set(index, x) {
        if (this.lock) return;
        this.lock = true;
        this.fetchImg(x).then(flag => { if (flag) { IFQ.report(index, this.bigImageUrl, this.node.offsetTop); } else { console.log("没有获取到图片，这期间一定发生了什么异常的事情！") } this.lock = false; })
    }

    //立刻将当前元素的src赋值给大图元素
    setNow(index) {
        if (this.stage === 2) {
            IFQ.report(index, this.bigImageUrl, this.node.offsetTop);
        } else {
            bigImageElement.src = this.oldSrc;
            bigImageElement.classList.add("fetching");
        }
        pageHelperHandler(1, index + 1);
    }
}
IMGFetcher.extractBigImgUrl = /\<img\sid=\"img\"\ssrc=\"(.*)\"\sstyle/;

//奇怪的专门的图片请求器
IMGFetcher.weirdFetch = function (imgE, url, oldUrl) {
    return new Promise(function (resolve, reject) {
        imgE.setAttribute("importance", "high");//提高图片加载优先级
        imgE.onloadstart = function (event) { imgE.timeoutId = window.setTimeout(() => { imgE.onloadstart = null; imgE.onloadend = null; imgE.src = oldUrl; resolve({ flag: false }); }, 10000); };//10秒后直接请求失败，然后会重试2次
        imgE.onloadend = function (event) { window.clearTimeout(imgE.timeoutId); resolve({ flag: true }); };
        imgE.src = url;//将大图地址赋值给图片元素，如果图片加载完成后就会调用resolve函数，达到同步效果
    });
}

class IMGFetcherQueue extends Array {
    constructor() {
        super();
        //可执行队列
        this.executableQueue = [];
        //延迟器的id收集,用于清理不需要执行的延迟器
        this.tids = [];
        //当前的显示的大图的图片请求器所在的索引
        this.currIndex = 0;
        //触发边界后的加载锁
        this.edgeLock = false;
        //扩容后需要修复索引
        this.neexFixIndex = false;
        //旧长度记录
        this.oldLength = this.length;
    }

    do(start, step, oriented) {
        step = step || 2; oriented = oriented || "next";
        this.currIndex = start = this.fixIndex(start, oriented);
        this[start].setNow(start);
        this.pushExecQueue(start, step, oriented);
        //终止自动加载
        this.abortIdleLoader();
        if (this.executableQueue.length === 0) return;
        /* 100毫秒的延迟，在这100毫秒的时间里，可执行队列executableQueue可能随时都会变更，100毫秒过后，只执行最新的可执行队列executableQueue中的图片请求器
            在对大图元素使用滚轮事件的时候，由于速度非常快，大量的IMGFetcher图片请求器被添加到executableQueue队列中，如果调用这些图片请求器请求大图，可能会被认为是爬虫脚本
            因此会有一个时间上的延迟，在这段时间里，executableQueue中的IMGFetcher图片请求器会不断更替，100毫秒结束后，只调用最新的executableQueue中的IMGFetcher图片请求器。
        */
        let tid = window.setTimeout((queue) => { queue.forEach(imgFetcherIndex => this[imgFetcherIndex].set(imgFetcherIndex)) }, 300, this.executableQueue);
        this.tids.push(tid);//收集当前延迟器id,，如果本方法的下一次调用很快来临，而本次调用的延迟器还没有执行，则清理掉本次的延迟器

        //是否达到最后一张或最前面的一张，如果是则判断是否还有上一页或者下一页需要加载
        this.needExpansion(this.executableQueue[this.executableQueue.length - 1], oriented);
    }

    //等待图片获取器执行成功后的上报，如果该图片获取器上报自身所在的索引和执行队列的currIndex一致，则改变大图
    report(index, imgSrc, offsetTop) {
        if (index === this.currIndex) {
            if (!conf.keepScale) {
                bigImageElement.style.height = "100%";
                bigImageElement.style.top = "0px";
            }
            bigImageElement.classList.remove("fetching");
            bigImageElement.src = imgSrc;
            let g = offsetTop - (window.screen.availHeight / 3);
            g = g <= 0 ? 0 : g >= fullViewPlane.scrollHeight ? fullViewPlane.scrollHeight : g;
            fullViewPlane.scrollTo({ top: g, behavior: "smooth" })
        }
    }

    //是否达到最后一张或最前面的一张，如果是则判断是否还有上一页或者下一页需要加载
    needExpansion(last, oriented) {
        if (this.edgeLock) return;
        last = oriented === "next" ? last + 1 : oriented === "prev" ? last - 1 : 0;
        if (last < 0 || last > this.length - 1) {
            this.edgeLock = true;
            this.oldLength = this.length;
            fetchStepPage(oriented).then(done => {
                if (done) {
                    this.edgeLock = false;
                    this.neexFixIndex = true;
                } else {
                    window.setTimeout(() => { this.edgeLock = false }, 2000);
                }
            });
        }
    }

    fixIndex(start, oriented) {
        start = start < 0 ? 0 : start > this.length - 1 ? this.length - 1 : start;
        if (this.neexFixIndex) {
            start = oriented === "prev" ? this.length - this.oldLength + start : start;
            this.neexFixIndex = false;
        }
        return start;
    }

    pushExecQueue(start, step, oriented) {
        //清理上一次调用时还没有执行的延迟器setTimeout
        this.tids.forEach(id => window.clearTimeout(id)); this.tids = [];
        //把要执行获取器先放置到队列中，延迟执行
        this.executableQueue = [];
        for (let index = start, count = 0; (((oriented === "next") && (index < this.length)) || ((oriented === "prev") && (index > -1))) && count < step; (oriented === "next") ? index++ : index--) {//丧心病狂
            if (this[index].stage === 2) continue;
            this.executableQueue.push(index);
            count++;
        }
        if (this.executableQueue.length === 0) return;
    }

    abortIdleLoader() {
        if (!conf.autoLoad) return;
        idleLoader.abort = true;
        //8s后重新开启，todo 但这里可能会出现小概率的双线程危机
        let tid = window.setTimeout((index) => { idleLoader.abort = false; idleLoader.start(index); }, 8000, this.currIndex);
        this.tids.push(tid);
    }
}

//空闲自加载
class IdleLoader {
    constructor(IFQ) {
        //图片获取器队列
        this.queue = IFQ;
        //当前处理
        this.currIndex = 0;
        //是否终止
        this.abort = false;
        //已完成
        this.finishedIF = [];
        //递归次数，防止无限递归
        this.recuTimes = 0;
    }
    async start(index) {
        this.currIndex = index;
        //如果被中止了，则停止
        if (this.abort || !conf.autoLoad) return;
        //如果索引到达了队列最后，则检测是否还有下一页
        if (index > this.queue.length - 1) {
            let fetchDone = await fetchStepPage("next");
            if (fetchDone && signal.nextFinished) {
                this.currIndex = index = 0;
            } else {
                throw "获取下一页失败，但并非是最后一页";
            }
        }
        //如果索引是0，则检测是否还有上一页
        if (index === 0) {
            let fetchDone = await fetchStepPage("prev");
            if (fetchDone || signal.prevFinished) {
                this.currIndex = index = 0;
            } else {
                throw "获取上一页失败，但并非是第一页";
            }
        }
        //如果所有的图片都加载完毕，则停止
        if (this.finishedIF.length === this.queue.length) {
            this.abort = true;
            console.log("所有页已经加载完毕！");
            return;
        }
        if (!this.queue[index].lock) {//当前的图片获取器没有被锁定
            this.queue[index].lock = true;//加锁
            const flag = await this.queue[index].fetchImg();
            this.queue[index].lock = false;
            if (flag && this.queue[index].stage === 2) {
                (this.finishedIF.indexOf(this.queue[index]) === -1) && (this.finishedIF.push(this.queue[index]));
            }
        }
        //当前要处理的图片获取器被锁住了，可能正在获取图片中，则停止自动获取，5s后再次执行
        if (this.queue[index].lock || this.recuTimes > 1000) {
            this.recuTimes = 0;
            window.setTimeout(this.start, 5000, index + 1);
            return;
        }
        this.recuTimes++; this.timeOut(index + 1).then(index => this.start(index));
    }

    async timeOut(index) {
        return new Promise(function (resolve, reject) {
            const time = Math.floor((Math.random() * 1500) + 500);
            window.setTimeout(resolve, time, index);
        });
    }
}

//==================面向对象，图片获取器IMGFetcher，图片获取器调用队列IMGFetcherQueue=====================FIN



//------------------------------------------------------------------------------------------------------------------------------------------------------------------------------



//===============================================配置管理器=================================================START
let conf = JSON.parse(window.localStorage.getItem("cfg_"));
//获取宽度
const screenWidth = window.screen.availWidth;

if (!conf || conf.version !== "1.0.1") {//如果配置不存在则初始化一个
    let rowCount = screenWidth > 2500 ? 9 : screenWidth > 1900 ? 7 : 5;
    conf = {
        backgroundImage: `data:image/png;base64,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`,
        gateBackgroundImage: `https://tvax3.sinaimg.cn/mw690/6762c771gy1gcv2eydei3g20f00l7e87.gif`,
        rowCount: rowCount,
        followMouse: true,
        keepScale: false,
        autoLoad: true,
        version: "1.0.1",
        first: true
    }
    window.localStorage.setItem("cfg_", JSON.stringify(conf));
}

const modCFG = function (k, v) {
    conf[k] = v;
    window.localStorage.setItem("cfg_", JSON.stringify(conf));
    updateEvent(k, v);
}

const updateEvent = function (k, v) {
    switch (k) {
        case "backgroundImage": {
            let css_ = [].slice.call(styleSheel.sheet.rules).filter(rule => rule.selectorText === ".fullViewPlane")[0];
            css_.style.backgroundImage = `url(${v})`;
            break;
        }
        case "rowCount": {
            let percent = (100 - (((v * 22) / window.screen.availWidth) * 100)) / v;
            percent = Math.floor(percent * 10) / 10;
            let css_ = [].slice.call(styleSheel.sheet.rules).filter(rule => rule.selectorText === ".fullViewPlane > img:not(.bigImageFrame)")[0];
            css_.style.width = percent + "%";
            break;
        }
        case "followMouse": {
            if (v) {
                bigImageFrame.addEventListener("mousemove", followMouseEvent);
            } else {
                bigImageFrame.removeEventListener("mousemove", followMouseEvent);
            }
            break;
        }
        case "pageHelper": {
            pageHelperHandler(0, "edge", "class");
            pageHelperHandler(1, "currPage", "class");
            pageHelperHandler(2, "totalPage", "class");
            pageHelperHandler(3, "edge", "class");
            pageHelperHandler(1, IFQ.currIndex + 1);
            pageHelperHandler(2, IFQ.length);
            break;
        }
        case "showGuide": {
            if (conf.first) {
                showGuideEvent();
                modCFG("first", false);
            }
            break;
        }
    }
}
//===============================================配置管理器=================================================FIN



//------------------------------------------------------------------------------------------------------------------------------------------------------------------------------



//===============================================方法区=================================================START
//提取下一页或上一页的地址 > 获取该地址的文档对象模型 > 从文档对象模型中提取图片列表 > 将图片列表追加到全屏阅览元素以及图片获取器队列中

//图片获取器调用队列
const IFQ = new IMGFetcherQueue();
//空闲自加载器
const idleLoader = new IdleLoader(IFQ);

//通过地址请求该页的文档对象模型
const fetchSource = async function (href, oriented) {
    if (href === null || !oriented) return null;
    const response = await window.fetch(href);
    const text = await response.text();
    let ele = document.createElement("div"); ele.innerHTML = text;
    return stepPageSource[oriented] = ele;
}

//上一页，起始页，下一页的文档对象模型，上一页和下一页会随着滚动加载而变更
const stepPageSource = {
    "prev": document,
    "curr": document,
    "next": document
}

//线程锁，如果上一页或下一页正在获取中，则设置为false，即加锁。
const signal = {
    "prev": true,
    "next": true,
    "first": true,
    "prevFinished": false,
    "nextFinished": false
}

//通过该页的内容获取下一页或上一页的地址 oriented : prev/next
const stepPageUrl = function (source, oriented) {
    let e1 = source.querySelector("table.ptb td.ptds"), stepE; if (!e1) return null;
    switch (oriented) {
        case "prev":
            stepE = e1.previousElementSibling;
            if (!stepE || stepE.textContent === "<") {
                signal.prevFinished = true;
                pageHelperHandler(0, "O");
                // pageHelperHandler(0, "edgeFIN", "class");
                return null
            };
            break;
        case "next":
            stepE = e1.nextElementSibling;
            if (!stepE || stepE.textContent === ">") {
                signal.nextFinished = true;
                pageHelperHandler(3, "O");
                // pageHelperHandler(3, "edgeFIN", "class");
                return null
            };
            break;
    }
    return stepE.firstElementChild.href;
}

//将该页的图片列表提取出来，然后追加到全屏阅读元素(fullViewPlane)上
const appendToFullViewPlane = function (source, oriented) {
    try {
        //从该页的文档中将图片列表提取出来
        let imageList = extractImageList(source);
        //每一个图片生成一个对应的大图处理器
        let IFs = imageList.map(img => new IMGFetcher(img));
        if (oriented === "prev") {//如果行动导向是上一页
            fullViewPlane.firstElementChild.nextElementSibling.after(...imageList);//则已全屏阅读元素的第一个元素为锚点，追加所有元素
            IFQ.unshift(...IFs);//则将所有的大图处理器添加到大图处理器数组的前部
        } else if (oriented === "next") {//如果行动导向是下一页
            fullViewPlane.lastElementChild.after(...imageList);
            IFQ.push(...IFs);
        }
        pageHelperHandler(2, IFQ.length);
        imageList.forEach(e => e.addEventListener("click", (event) => {
            //展开大图阅览元素
            bigImageFrame.classList.remove("retract");
            // bigImageFrame.appendChild(fragment.firstElementChild);
            bigImageElement.hidden = false;
            pageHelper.hidden = false;
            //获取该元素所在的索引
            IFQ.do([].slice.call(fullViewPlane.childNodes).indexOf(event.target) - 2);
        }))
        return true;
    } catch (error) {
        console.log("从下一页或上一页中提取图片元素时出现了错误！");
        console.log(error);
        return false;
    }
}

//提取传入的文档对象模型的图片列表
const extractImageList = function (source) {
    return [].slice.call(source.querySelector("#gdt").childNodes)
        .filter(node => (node.nodeType === 1 && node.hasChildNodes()))
        .map(node => { let imgE = node.firstElementChild.firstElementChild.cloneNode(true); imgE.setAttribute("ahref", node.firstElementChild.href); return imgE; })
}

//整合函数区的方法，提取下一页或上一页的地址 > 获取该地址的文档对象模型 > 从文档对象模型中提取图片列表 > 将图片列表追加到全屏阅览元素以及图片获取器队列中
//   此方法，当全屏阅览元素滚动时会被调用，动态加载上一页或下一页
//   此方法，当大图被滚动到当前的第一张图或最后一张图时被调用，尝试获取上一页或下一页
const fetchStepPage = async function (oriented) {
    if ((oriented === "prev" && signal.prevFinished) || (oriented === "next" && signal.nextFinished)) return false;
    //如果本事件还没有完成，则停止执行其他事件
    if ((oriented === "stop") || !signal[oriented]) return false;
    //从当前已经存在的下一页或上一页文档中获取下下一页或上上一页的地址
    let _stepPageUrl = stepPageUrl(stepPageSource[oriented], oriented);
    //如果下下一页或上上一页的地址不存在，停止执行下去
    if (_stepPageUrl === null) return false;
    signal[oriented] = false;//加锁
    const source = await fetchSource(_stepPageUrl, oriented);//获取下下一页或上上一页的文档
    signal[oriented] = true;//解锁
    //如果没有获取到下下一页或上上一页的文档则停止继续执行
    if (source === null) return false;
    return appendToFullViewPlane(source, oriented);
}
//===============================================方法区=================================================FIN



//------------------------------------------------------------------------------------------------------------------------------------------------------------------------------



//========================================事件库============================================START
//大图框架添加鼠标移动事件，该事件会将让大图跟随鼠标左右移动
const followMouseEvent = function (event) {
    if (bigImageFrame.moveEventLock) return;
    bigImageFrame.moveEventLock = true;
    window.setTimeout(() => { bigImageFrame.moveEventLock = false; }, 20)
    bigImageElement.style.left = `${event.clientX - (window.screen.availWidth / 2)}px`;
}

//修正图片top位置
const fixImageTop = function (mouseY, isScale) {
    //垂直轴中心锚点，用来计算鼠标距离垂直中心点的距离，值是一个正负数
    const vertAnchor = bigImageFrame.offsetHeight >> 1;
    //大图和父元素的高度差，用来修正图片的top值，让图片即使放大后也垂直居中在父元素上
    const diffHeight = bigImageElement.offsetHeight - bigImageFrame.offsetHeight - 3;
    //如果高度差为0，说明图片没缩放，不做处理
    if (diffHeight === 0 && !isScale) return;
    // 鼠标距离垂直中心的距离，正负值
    const dist = mouseY - vertAnchor;
    /* 移动比率，根据这个来决定imgE的top位置
     1.6是一个比率放大因子，
        比如鼠标向上移动时，移动到一定的距离就能看到图片的底部了，
                          而不是鼠标移动到浏览器的顶部才能看到图片底部 */
    const rate = Math.round((dist / vertAnchor * 1.6) * 100) / 100;
    //如果移动比率到达1或者-1，说明图片到低或到顶，停止继续移动
    if ((rate > 1 || rate < -1) && !isScale) return;
    //根据移动比率和高度差的1/2来计算需要移动的距离
    const topMove = Math.round((diffHeight >> 1) * rate);
    /* -(diffHeight >> 1) 修正图片位置基准，让放大的图片也垂直居中在父元素上 */
    bigImageElement.style.top = -(diffHeight >> 1) + topMove + "px";
}

//缩放图片事件
const scaleImageEvent = function (event) {
    //获取图片的高度, 值是百分比
    let height = bigImageElement.style.height || "100%";
    if (event.deltaY < 0) {//放大
        height = parseInt(height) + 15 + "%";
    } else {//缩小
        height = parseInt(height) - 15 + "%";
    }
    if (parseInt(height) < 100 || parseInt(height) > 200) return;
    bigImageElement.style.height = height;
    //最后对图片top进行修正
    fixImageTop(event.clientY, true);
}

//滚动加载上一张或下一张事件
const stepImageEvent = function (event) {
    //确定导向
    const oriented = event.deltaY > 0 ? "next" : "prev";
    //下一张索引
    const start = oriented === "next" ? IFQ.currIndex + 1 : oriented === "prev" ? IFQ.currIndex - 1 : 0;
    //是否达到最后一张或最前面的一张，如果是则判断是否还有上一页或者下一页需要加载，如果还有需要加载的页，则等待页加载完毕后再调用执行队列IFQ.do
    IFQ.do(start, null, oriented);
}
//修改配置时的布尔值类型的事件
const boolElementEvent = function (event) {
    event.target.blur();//让该输入框元素立即失去焦点
    let val = event.target.value;
    if (val === "✓") {
        event.target.value = "X";
        modCFG(event.target.getAttribute("confKey"), false);
    } else {
        event.target.value = "✓";
        modCFG(event.target.getAttribute("confKey"), true);
    }
}
//修改配置时的输入型类型事件
const inputElementEvent = function (event) {
    let val = event.target.previousElementSibling.value;
    if (val) {
        modCFG(event.target.previousElementSibling.getAttribute("confKey"), val);
    } else {
        alert("请输入有效的网络图片地址！");
    }
}
//页码指示器通用修改事件
const pageHelperHandler = function (index, value, type) {
    const node = [].filter.call(pageHelper.childNodes, (node) => node.nodeType === Node.ELEMENT_NODE)[index];
    if (type === "class") {
        node.classList.add(value);
    } else {
        node.textContent = value;
    }
}
//修改每行数量事件的添加
const modRowEvent = function () {
    [].slice.call(modRowCount.childNodes).filter(node => node.nodeType === Node.ELEMENT_NODE).forEach((node, index) => {
        switch (index) {
            case 1:
            case 3: {
                node.addEventListener("click", (event) => {
                    if (event.target.textContent === "-") {
                        let val = event.target.nextElementSibling.value;
                        event.target.nextElementSibling.value = parseInt(val) - 1;
                        modCFG("rowCount", parseInt(val) - 1);
                    }
                    if (event.target.textContent === "+") {
                        let val = event.target.previousElementSibling.value;
                        event.target.previousElementSibling.value = parseInt(val) + 1;
                        modCFG("rowCount", parseInt(val) + 1);
                    }
                });
                break;
            }
            case 2: {
                node.addEventListener("input", (event) => {
                    let val = event.target.value || "7";
                    modCFG("rowCount", parseInt(val))
                });
                break;
            }
        }
    })
}
//显示简易指南事件
const showGuideEvent = function (event) {
    let guideFull = document.createElement("div");
    document.body.appendChild(guideFull);
    guideFull.innerHTML = `<img src="https://tvax3.sinaimg.cn/mw690/6762c771gy1gd1wqc5j1vj20r70eytcd.jpg" style="margin-top: 200px;border: 10px #4e72b7 solid;">`;
    guideFull.style = `position: absolute;width: 100%;height: 100%;background-color: #363c3c78;z-index: 2004;top: 0;`;
    guideFull.addEventListener("click", () => guideFull.remove());
}
//========================================事件库============================================FIN



//------------------------------------------------------------------------------------------------------------------------------------------------------------------------------



//==================创建入口按钮，追加到tag面板的右侧=====================START
let showBTNRoot = document.querySelector("#gd5");
let tempContainer = document.createElement("div");

//判断是否是Large模式，这样缩略图也算能看
if (document.querySelector("div.ths:nth-child(2)") === null) {
    tempContainer.innerHTML = `<p class="g2"><img src="https://exhentai.org/img/mr.gif"> <a id="renamelink" href="${window.location.href}?inline_set=ts_l">请切换至Large模式</a></p>`;
    showBTNRoot.appendChild(tempContainer.firstElementChild);
} else {
    tempContainer.innerHTML = `<img src="${conf.gateBackgroundImage}" referrerpolicy="no-referrer" style="width: 125px; height: 30px;">`;
    showBTNRoot.appendChild(tempContainer.firstElementChild);
    showBTNRoot.lastElementChild.addEventListener("click", (event) => {
        fullViewPlane.classList.remove("retract_full_view");
        if (signal.first) {
            appendToFullViewPlane(document, "next");
            idleLoader.start(0);
            signal.first = false;
        }
    })
}
//==================创建入口按钮，追加到tag面板的右侧=====================FIN



//------------------------------------------------------------------------------------------------------------------------------------------------------------------------------



//========================================创建一个全屏阅读元素============================================START
let fullViewPlane = document.createElement("div");
fullViewPlane.classList.add("fullViewPlane");
fullViewPlane.classList.add("retract_full_view");
document.body.appendChild(fullViewPlane);

//创建一个配置面板，追加到全屏阅读元素的第一个位置
let configPlane = document.createElement("div");
configPlane.classList.add("configPlane");
fullViewPlane.appendChild(configPlane);

//修改背景图片
let modBGElement = document.createElement("div");
configPlane.appendChild(modBGElement);
modBGElement.innerHTML = `<span>修改背景图 : </span><input type="text" placeholder="网络图片" style="width: 200px;" confKey="backgroundImage"><button>确认</button>`;
modBGElement.lastElementChild.addEventListener("click", inputElementEvent);

//修改入口图片
let modGateBGElement = document.createElement("div");
configPlane.appendChild(modGateBGElement);
modGateBGElement.innerHTML = `<span>修改入口图 : </span><input type="text" placeholder="网络图片" style="width: 200px;" confKey="gateBackgroundImage"><button>确认</button>`;
modGateBGElement.lastElementChild.addEventListener("click", inputElementEvent);

//每行显示数量
let modRowCount = document.createElement("div");
configPlane.appendChild(modRowCount);
modRowCount.innerHTML = `<span>每行数量 : </span><button>-</button><input type="text" style="width: 20px;" value="${conf.rowCount}"><button>+</button>`;
modRowEvent();

//大图是否跟随鼠标
let modfollowMouse = document.createElement("div");
configPlane.appendChild(modfollowMouse);
modfollowMouse.innerHTML = `<span>大图跟随鼠标 : </span><input style="width: 10px; cursor: pointer; font-weight: bold; padding-left: 3px;" confKey="followMouse"  value="${conf.followMouse ? "✓" : "X"}" type="text"><button style="cursor: not-allowed;">装饰</button>`
modfollowMouse.lastElementChild.previousElementSibling.addEventListener("click", boolElementEvent);

//下一张是否保留图片放大
let keepImageScale = document.createElement("div");
configPlane.appendChild(keepImageScale);
keepImageScale.innerHTML = `<span>保留缩放 : </span><input style="width: 10px; cursor: pointer; font-weight: bold; padding-left: 3px;" confKey="keepScale" value="${conf.keepScale ? "✓" : "X"}" type="text"><button style="cursor: not-allowed;">装饰</button>`
keepImageScale.lastElementChild.previousElementSibling.addEventListener("click", boolElementEvent);

//是否自动加载
let autoLoad = document.createElement("div");
configPlane.appendChild(autoLoad);
autoLoad.innerHTML = `<span>自动加载 : </span><input style="width: 10px; cursor: pointer; font-weight: bold; padding-left: 3px;" confKey="autoLoad"  value="${conf.autoLoad ? "✓" : "X"}" type="text"><button style="cursor: not-allowed;">装饰</button>`
autoLoad.lastElementChild.previousElementSibling.addEventListener("click", boolElementEvent);

//显示指南
let showGuide = document.createElement("div");
configPlane.appendChild(showGuide);
showGuide.innerHTML = `<span>指南 : </span><button>打开</button>`
showGuide.lastElementChild.addEventListener("click", showGuideEvent);

//创建一个大图框架元素，追加到全屏阅读元素的第二个位置
let bigImageFrame = document.createElement("div");
bigImageFrame.classList.add("bigImageFrame");
bigImageFrame.classList.add("retract");
fullViewPlane.appendChild(bigImageFrame);

//大图框架图像容器，追加到大图框架里
let fragment = document.createDocumentFragment();
let bigImageElement = document.createElement("img");
let pageHelper = document.createElement("div");
bigImageFrame.appendChild(bigImageElement);
bigImageFrame.appendChild(pageHelper);

pageHelper.classList.add("pageHelper");
pageHelper.innerHTML = `<span>...</span><span>${IFQ.currIndex}</span>/<span>${IFQ.length}</span><span>...</span>`;
pageHelper.hidden = true;
bigImageElement.hidden = true;


//全屏阅读元素滚轮事件
fullViewPlane.addEventListener("wheel", (event) => {
    //对冒泡的处理
    if (event.target === bigImageFrame || event.target === bigImageElement || [].slice.call(bigImageFrame.childNodes).indexOf(event.target) > 0) return;
    //确定导向，向下滚动还是向上滚动
    let st = fullViewPlane.scrollTop, stm = fullViewPlane.scrollTopMax, oriented = (st === stm && st === 0) ? "prev.next" : (st === 0) ? "prev" : (st === stm) ? "next" : "stop";
    oriented.split(".").forEach(fetchStepPage);
});

//全屏阅览元素点击事件，点击空白处隐藏
fullViewPlane.addEventListener("click", (event) => { if (event.target === fullViewPlane) { fullViewPlane.classList.add("retract_full_view"); }; });

//取消在大图框架元素上的右键事件
bigImageFrame.addEventListener("contextmenu", (event) => { event.preventDefault(); });

//大图框架点击事件，点击后隐藏大图框架
bigImageFrame.addEventListener("click", (event) => {
    if (event.target.tagName === "SPAN") return;
    bigImageFrame.classList.add("retract");
    window.setTimeout(() => {
        // fragment.appendChild(bigImageFrame.firstElementChild);
        bigImageElement.hidden = true;
        pageHelper.hidden = true;
    }, 700);
});

//大图框架元素的滚轮事件
bigImageFrame.addEventListener("wheel", (event) => {
    if (event.buttons === 2) {
        scaleImageEvent(event);
    } else {
        stepImageEvent(event);
    }
});

//大图放大后鼠标移动事件
bigImageFrame.addEventListener("mousemove", (event) => { fixImageTop(event.clientY, false); })

//========================================创建一个全屏阅读元素============================================FIN



//------------------------------------------------------------------------------------------------------------------------------------------------------------------------------



//=========================================创建样式表==================================================START
let styleSheel = document.createElement("style");
styleSheel.textContent =
    `.fullViewPlane{width:100%;height:100%;background-color:#000;position:fixed;top:0;right:0;z-index:1000;overflow:scroll;transition:height .4s;display:flex;flex-wrap:wrap}.fullViewPlane>img:not(.bigImageFrame){margin:20px 0 0 20px;border:3px white solid;box-sizing:border-box;height:max-content}.retract_full_view{height:0;transition:height .4s}.configPlane{height:30px;width:100%;background-color:#1e1c1c;margin:20px 20px 0}.configPlane>div{display:inline-block;background-color:#00ffff3d;border:1px solid black;margin:0 5px;box-sizing:border-box;height:30px;padding:0 5px}.configPlane>div>span{line-height:20px;color:black;font-size:15px;font-weight:bolder}.configPlane>div>input{border:2px solid black;border-radius:0;margin-top:0!important;vertical-align:bottom}.configPlane>div>button{height:25px;border:2px solid black;background-color:#383940;margin-top:1px;box-sizing:border-box;color:white}.bigImageFrame{position:fixed;width:100%;height:100%;right:0;z-index:1001;background-color:#000000d6;justify-content:center;transition:width .4s}.bigImageFrame>img{height:100%;border:3px #602a5c solid;position:relative}.bigImageFrame>.pageHelper{position:absolute;right:100px;bottom:40px;background-color:#1e1c1c;z-index:1003;font-size:22px}.bigImageFrame>.pageHelper>.edge{background-color:#00ffff3d}.bigImageFrame>.pageHelper>.edgeFIN{background-color:green}.bigImageFrame>.pageHelper>.totalPage{font-size:17px}.bigImageFrame>.pageHelper>.currPage{color:orange}.fetching{animation:.5s linear infinite rrr}@keyframes rrr{0%{border-image:linear-gradient(0deg,#fd696a,#5461f4) 1}25%{border-image:linear-gradient(90deg,#fd696a,#5461f4) 1}50%{border-image:linear-gradient(180deg,#fd696a,#5461f4) 1}75%{border-image:linear-gradient(270deg,#fd696a,#5461f4) 1}100%{border-image:linear-gradient(360deg,#fd696a,#5461f4) 1}}.retract{width:0;transition:width .7s}.closeBTN{width:100%;height:100%;background-color:#0000;color:#f45b8d;font-size:30px;font-weight:bold;border:4px #f45b8d solid;border-bottom-left-radius:60px}.closeBTN>span{position:fixed;right:11px;top:0}`;
document.head.appendChild(styleSheel);

updateEvent("backgroundImage", conf.backgroundImage);
updateEvent("rowCount", conf.rowCount);
updateEvent("followMouse", conf.followMouse);
updateEvent("pageHelper", null);
updateEvent("showGuide", null);
//=========================================创建样式表==================================================FIN