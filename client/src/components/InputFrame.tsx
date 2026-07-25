import { type Component, splitProps, type JSX } from 'solid-js'
import { Frame } from './Frame'

interface InputFrameProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
    label: string
}

export const InputFrame: Component<InputFrameProps> = (props) => {
    const [_, others] = splitProps(props, ['label'])
    return (
        <Frame
            content={
                <input
                    {...(others as any)}
                    class="w-full text-left outline-none"
                />
            }
        />
    )
}
