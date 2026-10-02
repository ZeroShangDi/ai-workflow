# 外部输入到达不同边界时，应如何校验和输出？
关键词：输入校验、信任边界、输出编码
答案：在可信边界按预期类型、格式、范围和业务规则校验外部输入，并限制大小与复杂度；校验不能替代授权。保存后的数据仍可能来自不可信来源，输出时按 HTML、属性、URL、脚本等目标上下文使用框架安全输出或相应编码。需要允许用户提交 HTML 时，使用维护中的白名单净化器；不要把普通字符串编码和 HTML 净化混为一谈。参考：[OWASP 输入校验](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)、[XSS 防护](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)。

# 如何防止 SQL、命令或类似表达式中的注入？
关键词：SQL注入、命令注入、参数化
答案：让数据与可执行语法分离：数据库使用参数化查询；动态列名、排序字段等不能绑定为参数的位置，使用固定映射或白名单；调用外部程序优先使用结构化参数接口并限制可执行目标，不拼接 shell 命令。编码或过滤输入不能替代参数化，也不要把 ORM 视为自动免疫。参考：[OWASP SQL 注入防护](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)、[注入防护](https://cheatsheetseries.owasp.org/cheatsheets/Injection_Prevention_Cheat_Sheet.html)。

# 如何确认用户有权访问某个对象或执行某项操作？
关键词：服务端授权、对象级权限、IDOR
答案：在可信服务端根据已认证主体、具体资源归属和请求动作做授权判断，并在每个受保护入口执行；默认拒绝无法证明被允许的操作。随机 ID、隐藏按钮或客户端角色状态都不能替代权限检查。用不同用户访问彼此资源、改变对象 ID、调用未展示在 UI 的接口等反例验证对象级授权与租户隔离。参考：[OWASP 授权](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)。

# 文件上传需要哪些相互补充的检查？
关键词：文件上传、类型校验、隔离存储
答案：只接受业务所需的扩展名白名单；不要信任客户端 `Content-Type`，并按风险检查文件签名或解析实际内容。为上传限制大小和处理资源，使用服务端生成的存储名，验证授权，并将文件放在不可直接执行的位置；是否扫描内容取决于文件类型与威胁模型。单一扩展名、MIME 或签名检查都不能独立证明文件安全。参考：[OWASP 文件上传](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)。

# 服务端请求用户提供的 URL 时，怎样降低 SSRF 风险？
关键词：SSRF、出站请求、URL校验
答案：若业务只需访问已知目标，接收目标标识并映射到服务端允许的 scheme、主机、端口和路径，避免接受任意完整 URL。确需请求任意外部地址时，校验 scheme 与解析后的 IPv4/IPv6 地址，阻止 loopback、私有、链路本地等内部地址，并处理 DNS 解析变化；禁用自动重定向，或对每一跳重新执行验证。再用网络出口策略限制代码层检查遗漏的内网访问。参考：[OWASP SSRF 防护](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)。

# 密钥、会话凭据和认证数据怎样存储与传递？
关键词：密钥管理、会话、凭据
答案：密码使用维护中的自适应密码哈希实现，不以快速通用哈希替代；具体算法和参数按当前标准、框架能力及服务容量核实。应用密钥放在受控秘密管理设施，按最小权限读取，避免写入源码、客户端包、URL 和日志。Web 会话 cookie 按部署设置 `Secure`、`HttpOnly` 和适合跨站流程的 `SameSite`；这些属性减少凭据暴露面，但不能替代授权或修复 XSS。凭据泄漏后要能撤销或轮换。参考：[OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)、[会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[秘密管理](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)。

# 安全日志如何帮助调查而不泄漏敏感信息？
关键词：安全日志、敏感数据、脱敏
答案：记录足以重建安全事件的主体、动作、目标、结果和时间等必要信息，并限制日志访问与保留；不要直接记录密码、访问令牌、会话凭据或不必要的个人数据。确需跨记录关联会话时，采用不暴露原凭据的关联标识。对用户可控字段防止日志注入，并检查异常栈、请求头和查询参数是否意外带出秘密。参考：[OWASP 日志](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)、[OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。

# 引入第三方依赖时怎样控制供应链风险？
关键词：依赖供应链、漏洞更新、软件来源
答案：先确认新依赖是否必要，再核查维护状态、来源、许可、发布与安装脚本、传递依赖和当前已知漏洞；锁文件保证所选解析结果可复现，但不证明包本身可信。结合项目工具监测安全公告并安排升级验证；新增或高影响依赖需检查其实际安装和运行能力，不把一次审计无告警当成永久安全证明。
